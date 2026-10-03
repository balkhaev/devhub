import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import {
	appendFile,
	mkdir,
	open,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import { developmentSourceIssue } from "./checkouts";
import type { Service } from "./config";
import { capture, processInfo } from "./probes";

/**
 * The dev servers the hub starts. Each runs on its own, hidden, with its output in `.logs/<project>-<service>.log`,
 * so it outlives the hub, which finds it again from `.state/processes.json`. On Windows a small batch file in
 * `.state/run` starts it: launched through `Start-Process -WindowStyle Hidden` it gets a console of its own that
 * nobody sees (a detached process would open a terminal window for every server under it), and it writes the exit
 * code to `.state/exit` when the server ends. Stopping ends the whole process tree.
 */

export interface Managed {
	command: string;
	cwd: string;
	/** Set when the process ended while the hub watched it; the code is unknown when it was killed. */
	exit: { at: number; code: number | null } | null;
	log: string;
	pid: number;
	startedAt: number;
	/** The person asked it to stop: its end is not a crash. */
	stopping: boolean;
}

const TAIL_BYTES = 256 * 1024;
/** A log longer than this is moved aside to `.old` when its service starts again. */
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const WINDOWS = process.platform === "win32";
const LAUNCH_MS = 20_000;
/** What a batch `set "NAME=value"` cannot carry. */
const UNSAFE_VALUE = /["\r\n]/;
const SERVICE_KEY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const COMMAND_ARGUMENT = /"([^"]+)"|([^\s"]+)/g;
const LEADING_EXECUTABLE = /^(?:"([^"]+)"|([^\s]+))/;
const NEWLINE = 0x0a;

const fileName = (service: Service): string => service.key.replace("/", "-");

export const logFileOf = (root: string, service: Service): string =>
	join(root, ".logs", `${fileName(service)}.log`);

/** A reused PID only belongs to this hub when its launcher names this exact batch file. */
export function commandNamesBatch(command: string, batch: string): boolean {
	const normalize = (value: string) =>
		value.replaceAll("/", "\\").toLowerCase();
	const expected = normalize(batch);
	return [...command.matchAll(COMMAND_ARGUMENT)].some(
		(match) => normalize(match[1] ?? match[2] ?? "") === expected
	);
}

const stamp = (): string => new Date().toLocaleString("ru-RU");

/** Whether a process still exists. */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Ends a process and every process under it. */
export async function killTree(pid: number): Promise<void> {
	if (WINDOWS) {
		await capture("taskkill", ["/pid", String(pid), "/T", "/F"]);
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		process.kill(pid, "SIGTERM");
	}
}

/** The environment every server gets: plain output, UTF-8, no buffering. */
function environment(service: Service, root: string): Record<string, string> {
	const binaries = new Set<string>();
	let folder = resolve(service.workdir);
	const projectRoot = resolve(service.project.path);
	binaries.add(join(folder, "node_modules", ".bin"));
	while (folder !== projectRoot && folder !== dirname(folder)) {
		folder = dirname(folder);
		binaries.add(join(folder, "node_modules", ".bin"));
	}
	binaries.add(join(projectRoot, "node_modules", ".bin"));
	const inheritedPath =
		service.env.PATH ??
		service.env.Path ??
		process.env.PATH ??
		process.env.Path ??
		"";
	return {
		FORCE_COLOR: "0",
		NO_COLOR: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONUNBUFFERED: "1",
		...service.env,
		DEVHUB_PROJECT: projectRoot,
		DEVHUB_ROOT: root,
		DEVHUB_SERVICE: service.key,
		NODE_ENV: "development",
		PATH: [...binaries, inheritedPath].join(delimiter),
	};
}

/** cmd.exe requires backslashes in the executable path; argument URLs keep their slashes. */
export function windowsCommand(command: string): string {
	return command.replace(
		LEADING_EXECUTABLE,
		(original, quoted: string | undefined, bare: string | undefined) => {
			const executable = quoted ?? bare;
			if (!executable?.includes("/")) {
				return original;
			}
			const path = executable.replaceAll("/", "\\");
			return quoted ? `"${path}"` : path;
		}
	);
}

function batchRun(service: Service): string[] {
	const command = windowsCommand(service.command ?? "");
	if (service.restart === "never") {
		return [`call ${command}`, "exit /b %errorlevel%"];
	}
	return [
		":retry",
		`call ${command}`,
		'set "DEVHUB_EXIT_CODE=%errorlevel%"',
		...(service.restart === "on-failure"
			? ['if "%DEVHUB_EXIT_CODE%"=="0" exit /b 0']
			: []),
		`echo === devhub: exited with code %DEVHUB_EXIT_CODE%; restarting in ${service.restartDelayMs} ms`,
		`powershell -NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds ${service.restartDelayMs}"`,
		"goto retry",
	];
}

/** A POSIX supervisor keeps the same process-group owner between retries. */
export function detachedCommand(service: Service): string {
	const command = service.command ?? "";
	if (service.restart === "never") {
		return command;
	}
	return [
		"while :; do",
		command,
		"devhub_exit=$?",
		...(service.restart === "on-failure"
			? ['if [ "$devhub_exit" -eq 0 ]; then break; fi']
			: []),
		`printf '=== devhub: exited with code %s; restarting in ${service.restartDelayMs} ms\\n' "$devhub_exit"`,
		`sleep ${service.restartDelayMs / 1000}`,
		"done",
		'exit "$devhub_exit"',
	].join("\n");
}

/** The batch file that runs a service on Windows: its folder, its environment, its output into the log. */
export function batchOf(
	service: Service,
	log: string,
	exitFile: string,
	root = resolve(dirname(dirname(log)))
): string {
	const env = Object.entries(environment(service, root)).map(
		([name, value]) => {
			if (UNSAFE_VALUE.test(value)) {
				throw new Error(
					`переменная ${name} сервиса ${service.key}: кавычки и переводы строк в значении не поддерживаются`
				);
			}
			return `set "${name}=${value.replaceAll("%", "%%")}"`;
		}
	);
	return [
		"@echo off",
		"chcp 65001 > nul",
		`cd /d "${service.workdir}"`,
		...env,
		`call :run >> "${log}" 2>&1`,
		`> "${exitFile}" echo %errorlevel%`,
		"exit /b",
		":run",
		// `call`, so a command that is itself a batch file (npm, npx) returns here.
		...batchRun(service),
		"",
	].join("\r\n");
}

/** Starts a batch file hidden, in a console of its own; returns its process id. */
export async function launchHidden(batch: string): Promise<number> {
	const script = `(Start-Process -FilePath '${batch.replaceAll("'", "''")}' -WindowStyle Hidden -PassThru).Id`;
	const out = await capture(
		"powershell",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
		],
		LAUNCH_MS
	);
	return Number(out.trim());
}

/** Starts a command detached, its output into the log (everywhere but Windows). */
function launchDetached(service: Service, log: string, root: string): number {
	const fd = openSync(log, "a");
	const child = spawn(detachedCommand(service), {
		cwd: service.workdir,
		detached: true,
		env: { ...process.env, ...environment(service, root) },
		shell: true,
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);
	child.unref();
	return child.pid ?? 0;
}

export class Processes {
	private readonly root: string;
	private readonly stateFile: string;
	private readonly running = new Map<string, Managed>();
	private saving: Promise<void> = Promise.resolve();

	constructor(root: string) {
		this.root = resolve(root);
		this.stateFile = join(this.root, ".state", "processes.json");
	}

	private exitFileOf(key: string): string {
		return join(this.root, ".state", "exit", `${key.replace("/", "-")}.txt`);
	}

	/**
	 * Takes back the processes a previous run of the hub started and that still run. On Windows a process id is
	 * trusted only while its command line still names the hub's batch file: ids are reused.
	 */
	async adopt(): Promise<void> {
		if (!existsSync(this.stateFile)) {
			return;
		}
		let saved: Record<string, Managed> = {};
		try {
			const parsed: unknown = JSON.parse(
				await readFile(this.stateFile, "utf8")
			);
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				!Array.isArray(parsed)
			) {
				saved = parsed as Record<string, Managed>;
			}
		} catch {
			// A damaged state file: the processes it named are found again by their ports.
		}
		const living = Object.entries(saved).filter(
			([key, entry]) =>
				SERVICE_KEY.test(key) &&
				entry !== null &&
				typeof entry === "object" &&
				Number.isInteger(entry.pid) &&
				entry.pid > 0 &&
				typeof entry.command === "string" &&
				typeof entry.cwd === "string" &&
				typeof entry.log === "string" &&
				Number.isFinite(entry.startedAt) &&
				alive(entry.pid)
		);
		const info = WINDOWS
			? await processInfo(living.map(([, entry]) => entry.pid))
			: null;
		for (const [key, entry] of living) {
			const command = info?.get(entry.pid)?.command ?? "";
			const batch = join(
				this.root,
				".state",
				"run",
				`${key.replace("/", "-")}.cmd`
			);
			const ours = !info || commandNamesBatch(command, batch);
			if (ours) {
				this.running.set(key, { ...entry, exit: null, stopping: false });
			}
		}
		await this.save();
	}

	get(key: string): Managed | undefined {
		return this.running.get(key);
	}

	/** How many servers the hub started are running now. */
	liveCount(): number {
		return [...this.running.values()].filter(
			(entry) => !entry.exit && alive(entry.pid)
		).length;
	}

	/** Notes the processes that ended, with their exit codes; returns whether any did. */
	sweep(): boolean {
		let changed = false;
		for (const [key, entry] of this.running) {
			if (entry.exit || alive(entry.pid)) {
				continue;
			}
			const exitFile = this.exitFileOf(key);
			const written = existsSync(exitFile)
				? Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10)
				: Number.NaN;
			const code = Number.isNaN(written) ? null : written;
			entry.exit = { at: Date.now(), code };
			let words = "процесс завершился";
			if (entry.stopping) {
				words = "остановлен из пульта";
			} else if (code !== null) {
				words = code === 0 ? "завершился" : `завершился с кодом ${code}`;
			}
			try {
				appendFileSync(entry.log, `=== ${stamp()} · ${words}\n`);
			} catch {
				// The log is gone: the state still says how it ended.
			}
			changed = true;
		}
		if (changed) {
			this.save().catch(() => undefined);
		}
		return changed;
	}

	async start(service: Service): Promise<Managed> {
		const sourceIssue = developmentSourceIssue(
			service.project.path,
			service.workdir
		);
		if (sourceIssue) {
			throw new Error(`${service.key}: ${sourceIssue}`);
		}
		if (!service.command) {
			throw new Error(
				`${service.name} запускается не из пульта: пульт только следит за ним`
			);
		}
		const current = this.running.get(service.key);
		if (current && !current.exit && alive(current.pid)) {
			throw new Error(`${service.name} уже работает (PID ${current.pid})`);
		}
		if (!existsSync(service.workdir)) {
			throw new Error(`нет папки ${service.workdir}`);
		}
		const log = logFileOf(this.root, service);
		await mkdir(dirname(log), { recursive: true });
		if (existsSync(log) && (await stat(log)).size > LOG_LIMIT_BYTES) {
			await rename(log, `${log}.old`);
		}
		await appendFile(
			log,
			`\n=== ${stamp()} · ${service.command} (в ${service.workdir})\n`
		);
		let pid = 0;
		if (WINDOWS) {
			const exitFile = this.exitFileOf(service.key);
			const batch = join(
				this.root,
				".state",
				"run",
				`${fileName(service)}.cmd`
			);
			await mkdir(dirname(exitFile), { recursive: true });
			await mkdir(dirname(batch), { recursive: true });
			rmSync(exitFile, { force: true });
			await writeFile(batch, batchOf(service, log, exitFile, this.root));
			pid = await launchHidden(batch);
		} else {
			pid = launchDetached(service, log, this.root);
		}
		if (!(pid > 0)) {
			throw new Error(`${service.command} не запустился`);
		}
		const entry: Managed = {
			command: service.command,
			cwd: service.workdir,
			exit: null,
			log,
			pid,
			startedAt: Date.now(),
			stopping: false,
		};
		this.running.set(service.key, entry);
		await this.save();
		return entry;
	}

	/** Stops the process the hub started for a service. */
	async stop(service: Service): Promise<boolean> {
		const entry = this.get(service.key);
		if (!entry || entry.exit || !alive(entry.pid)) {
			return false;
		}
		entry.stopping = true;
		await killTree(entry.pid);
		this.sweep();
		return true;
	}

	/** A service's log from an offset on (its last part when there is none), and the offset to read on from. */
	async tail(
		service: Service,
		from?: number
	): Promise<{ offset: number; reset: boolean; text: string }> {
		const log = logFileOf(this.root, service);
		if (!existsSync(log)) {
			return { offset: 0, reset: from === undefined, text: "" };
		}
		const { size } = await stat(log);
		// No offset yet, or the log was moved aside and began again: send its last part afresh.
		const reset = from === undefined || from > size;
		const start = reset ? Math.max(0, size - TAIL_BYTES) : from;
		if (start >= size) {
			return { offset: size, reset, text: "" };
		}
		const handle = await open(log, "r");
		try {
			const buffer = Buffer.alloc(size - start);
			await handle.read(buffer, 0, buffer.length, start);
			// Whole lines only, so a letter being written is never cut in half: the rest comes with the next read.
			const first = reset && start > 0 ? buffer.indexOf(NEWLINE) + 1 : 0;
			const last = buffer.lastIndexOf(NEWLINE) + 1;
			const end = last > first ? last : buffer.length;
			return {
				offset: start + end,
				reset,
				text: buffer.subarray(first, end).toString("utf8"),
			};
		} finally {
			await handle.close();
		}
	}

	private save(): Promise<void> {
		const live = Object.fromEntries(
			[...this.running.entries()].filter(([, entry]) => !entry.exit)
		);
		const snapshot = `${JSON.stringify(live, null, 2)}\n`;
		const saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.stateFile), { recursive: true });
				const temporary = `${this.stateFile}.${process.pid}.tmp`;
				await writeFile(temporary, snapshot);
				await rename(temporary, this.stateFile);
			});
		this.saving = saving;
		return saving;
	}
}
