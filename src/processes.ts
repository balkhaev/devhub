import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
} from "node:fs";
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import { developmentSourceIssue } from "./checkouts";
import type { Service } from "./config";
import {
	approveLaunch,
	awaitReceipt,
	cancelLaunch,
	isLauncherIdentity,
	isLaunchMarker,
	type LauncherIdentity,
	type LaunchFiles,
	type LaunchIntent,
	launchFiles,
	matchesLauncher,
	namesBatch,
	readIntent,
	readReceipt,
	saveIntent,
} from "./desktop-launch";
import { nextDevNodeOptions } from "./next-dev-memory";
import { capture, type ProcessInfo, processInfo } from "./probes";

/**
 * The dev servers the hub starts. Each runs on its own, hidden, with its output in `.logs/<project>-<service>.log`,
 * so it outlives the hub, which finds it again from `.state/processes.json`. On Windows a small batch file in
 * `.state/run` starts it through Explorer, hidden and outside the hub's process tree. A receipt identifies the CMD
 * lifetime before its service is approved to run; `.state/exit` records that attempt's exit code.
 */

export interface Managed {
	command: string;
	cwd: string;
	/** Set when the process ended while the hub watched it; the code is unknown when it was killed. */
	exit: { at: number; code: number | null } | null;
	/** Absent only for legacy launchers created before the desktop receipt protocol. */
	launcher?: LauncherIdentity;
	log: string;
	pid: number;
	startedAt: number;
	/** The person asked it to stop: its end is not a crash. */
	stopping: boolean;
}

const TAIL_BYTES = 256 * 1024;
/** A log longer than this is set aside (see `rotateLog`) when its service starts again. */
export const LOG_LIMIT_BYTES = 8 * 1024 * 1024;
/** How many set-aside logs a service keeps, besides the newest one that holds a crash. */
const LOG_ROTATIONS = 3;
/** What follows `<service>.` in the name of a set-aside log. */
const ROTATED = /^\d{8}-\d{6}(?:\.crash)?\.log$/;
/** The hub's lines for an end nobody asked for (see `sweep`); a stop from the page reads «остановлен из пульта». */
const CRASH_WORDS = ["· завершился", "· процесс завершился"].map((words) =>
	Buffer.from(words)
);
const SCAN_BYTES = 1024 * 1024;
const WINDOWS = process.platform === "win32";
const LAUNCH_MS = 20_000;
/** What a batch `set "NAME=value"` cannot carry. */
const UNSAFE_VALUE = /["\r\n]/;
const SERVICE_KEY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const FRAME_ORIGIN = /^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?$/;
const LEADING_EXECUTABLE = /^(?:"([^"]+)"|([^\s]+))/;
const NEWLINE = 0x0a;
/** The shell's list of its windows (the ShellWindows COM class): Explorer serves it from its own process. */
const SHELL_WINDOWS = "9BA05972-F6A8-11CF-A442-00A0C90A8F39";
const SHELL_FAILED = /^failed: /;

const fileName = (service: Service): string => service.key.replace("/", "-");

export const logFileOf = (root: string, service: Service): string =>
	join(root, ".logs", `${fileName(service)}.log`);

const two = (value: number): string => String(value).padStart(2, "0");

/** A local time as `yyyyMMdd-HHmmss`, which sorts by time. */
const fileStamp = (at: Date): string =>
	`${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;

/** Whether a log holds an end nobody asked for; read in parts, since a log can grow large between starts. */
async function holdsCrash(file: string): Promise<boolean> {
	const overlap = Math.max(...CRASH_WORDS.map((words) => words.length)) - 1;
	const buffer = Buffer.alloc(overlap + SCAN_BYTES);
	const handle = await open(file, "r");
	try {
		let kept = 0;
		for (;;) {
			// biome-ignore lint/performance/noAwaitInLoops: one file read in order
			const { bytesRead } = await handle.read(buffer, kept, SCAN_BYTES, null);
			const part = buffer.subarray(0, kept + bytesRead);
			if (CRASH_WORDS.some((words) => part.includes(words))) {
				return true;
			}
			if (bytesRead === 0) {
				return false;
			}
			// Words cut between two reads are found with the next one.
			kept = Math.min(overlap, part.length);
			part.copy(buffer, 0, part.length - kept);
		}
	} finally {
		await handle.close();
	}
}

async function setAside(file: string, log: string, at: Date): Promise<void> {
	const crash = (await holdsCrash(file)) ? ".crash" : "";
	await rename(
		file,
		join(dirname(log), `${basename(log, ".log")}.${fileStamp(at)}${crash}.log`)
	);
}

/**
 * Before a start, sets a log over the limit aside as `<service>.<yyyyMMdd-HHmmss>.log`, or `….crash.log` when it
 * holds an end nobody asked for, and keeps the newest few of them plus the newest crash: a busy service rotating
 * several times a day never loses the log of its last crash. A `<service>.log.old` from the earlier single rotation
 * joins them under the time it was last written.
 */
export async function rotateLog(log: string, now = new Date()): Promise<void> {
	const legacy = `${log}.old`;
	if (existsSync(legacy)) {
		await setAside(legacy, log, (await stat(legacy)).mtime);
	}
	if (existsSync(log) && (await stat(log)).size > LOG_LIMIT_BYTES) {
		await setAside(log, log, now);
	}
	const directory = dirname(log);
	const prefix = `${basename(log, ".log")}.`;
	// Newest first: the stamp sorts by time.
	const aside = (await readdir(directory))
		.filter(
			(name) =>
				name.startsWith(prefix) && ROTATED.test(name.slice(prefix.length))
		)
		.sort()
		.reverse();
	const crash = aside.find((name) => name.endsWith(".crash.log"));
	await Promise.all(
		aside
			.slice(LOG_ROTATIONS)
			.filter((name) => name !== crash)
			// One that someone holds open goes at a later start.
			.map((name) =>
				rm(join(directory, name), { force: true }).catch(() => undefined)
			)
	);
}

/** A reused PID only belongs to this hub when its launcher names this exact batch file. */
export function commandNamesBatch(command: string, batch: string): boolean {
	return namesBatch(command, batch);
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
function environment(
	service: Service,
	root: string,
	frameOrigin: string
): Record<string, string> {
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
	const nodeOptions = nextDevNodeOptions(
		service.command,
		service.env.NODE_OPTIONS ?? process.env.NODE_OPTIONS
	);
	return {
		FORCE_COLOR: "0",
		NO_COLOR: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONUNBUFFERED: "1",
		...service.env,
		...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
		DEVHUB_FRAME_ORIGIN: frameOrigin,
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
	root = resolve(dirname(dirname(log))),
	frameOrigin = "",
	launch?: { files: LaunchFiles; intent: LaunchIntent }
): string {
	const env = Object.entries(environment(service, root, frameOrigin)).map(
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
		...(launch
			? [
					`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(import.meta.dir, "desktop-launch.ps1")}" -Marker "${launch.intent.marker}" -Batch "${launch.intent.batch}" -Intent "${launch.files.intent}" -Receipt "${launch.files.receipt}" -Approval "${launch.files.approval}"`,
					"if errorlevel 1 goto launch_failed",
				]
			: []),
		"chcp 65001 > nul",
		`cd /d "${service.workdir}"`,
		...env,
		`call :run >> "${log}" 2>&1`,
		`> "${exitFile}" echo ${launch ? `${launch.intent.marker} ` : ""}%errorlevel%`,
		"exit /b",
		...(launch
			? [
					":launch_failed",
					`> "${exitFile}" echo ${launch.intent.marker} 125`,
					"exit /b 125",
				]
			: []),
		":run",
		// `call`, so a command that is itself a batch file (npm, npx) returns here.
		...batchRun(service),
		"",
	].join("\r\n");
}

/**
 * Starts a batch file hidden, in a console of its own; returns its process id. The process keeps this one's view
 * of `%LOCALAPPDATA%`, which is why the hub itself never runs in an app's private one.
 */
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

/**
 * The PowerShell that asks the desktop shell to start a batch file hidden. The desktop's window is found among the
 * shell's windows (SWC_DESKTOP = 8) as a scriptable object (SWFO_NEEDDISPATCH = 1), and its `ShellExecute` runs in
 * Explorer's own process. It prints `started`, or why it could not.
 */
export function shellLaunchScript(batch: string, argumentsText = ""): string {
	const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
	return [
		`try { $windows = [Activator]::CreateInstance([Type]::GetTypeFromCLSID([Guid]'${SHELL_WINDOWS}'))`,
		"$hwnd = 0",
		"$desktop = $windows.FindWindowSW([ref]0, [ref]$null, 8, [ref]$hwnd, 1)",
		`$desktop.Document.Application.ShellExecute(${quoted(batch)}, ${quoted(argumentsText)}, ${quoted(dirname(batch))}, 'open', 0)`,
		"'started' } catch { 'failed: ' + $_.Exception.Message }",
	].join("; ");
}

/**
 * Starts a batch file hidden through the desktop shell, as Explorer's child. A process started any other way keeps
 * the `%LOCALAPPDATA%` view of the app this one was started from (`app-view.ts`); this one sees the real folder.
 * No process id comes back.
 */
export async function launchOutside(
	batch: string,
	argumentsText = ""
): Promise<void> {
	const out = await capture(
		"powershell",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			shellLaunchScript(batch, argumentsText),
		],
		LAUNCH_MS
	);
	const said = out.trim();
	if (said !== "started") {
		throw new Error(
			said.replace(SHELL_FAILED, "") || "оболочка рабочего стола не ответила"
		);
	}
}

/** Starts a command detached, its output into the log (everywhere but Windows). */
function launchDetached(
	service: Service,
	log: string,
	root: string,
	frameOrigin: string
): number {
	const fd = openSync(log, "a");
	const child = spawn(detachedCommand(service), {
		cwd: service.workdir,
		detached: true,
		env: { ...process.env, ...environment(service, root, frameOrigin) },
		shell: true,
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);
	child.unref();
	return child.pid ?? 0;
}

export class Processes {
	private frameOrigin = "";
	private readonly root: string;
	private readonly stateFile: string;
	private readonly running = new Map<string, Managed>();
	private readonly stopTree: typeof killTree;
	private readonly inspect: typeof processInfo;
	private readonly dispatch: typeof launchOutside;
	private readonly launchTimeoutMs: number | undefined;
	private readonly pending = new Map<
		string,
		{ cancelled: boolean; files: LaunchFiles; intent: LaunchIntent }
	>();
	private saving: Promise<void> = Promise.resolve();

	constructor(
		root: string,
		frameOrigin = "",
		stopTree = killTree,
		runtime: {
			inspect?: typeof processInfo;
			dispatch?: typeof launchOutside;
			launchTimeoutMs?: number;
		} = {}
	) {
		this.root = resolve(root);
		this.stateFile = join(this.root, ".state", "processes.json");
		this.stopTree = stopTree;
		this.inspect = runtime.inspect ?? processInfo;
		this.dispatch = runtime.dispatch ?? launchOutside;
		this.launchTimeoutMs = runtime.launchTimeoutMs;
		if (frameOrigin) {
			this.setFrameOrigin(frameOrigin);
		}
	}

	/** Use the bound DevHub port, including an ephemeral or command-line override. */
	setFrameOrigin(origin: string): void {
		const url = new URL(origin);
		if (
			!FRAME_ORIGIN.test(origin) ||
			url.protocol !== "http:" ||
			url.hostname !== "127.0.0.1"
		) {
			throw new Error(
				"DevHub frame origin must be its exact local HTTP origin"
			);
		}
		this.frameOrigin = origin;
	}

	private exitFileOf(key: string, marker?: string): string {
		return join(
			this.root,
			".state",
			"exit",
			`${key.replace("/", "-")}${marker ? `-${marker}` : ""}.txt`
		);
	}

	private exitCode(key: string, marker?: string): number | null {
		const file = this.exitFileOf(key, marker);
		const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
		if (marker && !text.startsWith(`${marker} `)) {
			return null;
		}
		const written = Number.parseInt(
			marker ? text.slice(marker.length + 1) : text,
			10
		);
		return Number.isNaN(written) ? null : written;
	}

	private recordedExit(key: string, entry: Managed): number | null {
		if (entry.launcher !== undefined && !isLauncherIdentity(entry.launcher)) {
			return null;
		}
		return this.exitCode(key, entry.launcher?.marker);
	}

	private recordedOwner(
		entry: Managed,
		info: ProcessInfo | undefined,
		batch: string
	): boolean {
		if (!WINDOWS) {
			return true;
		}
		if (entry.launcher === undefined) {
			return commandNamesBatch(info?.command ?? "", batch);
		}
		// A missing or malformed identity is uncertainty, never permission to kill or launch a duplicate.
		if (
			!(isLauncherIdentity(entry.launcher) && info?.created && info.command)
		) {
			return true;
		}
		return matchesLauncher(info, entry.launcher);
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
		const known = Object.entries(saved).filter(
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
				typeof entry.stopping === "boolean" &&
				(entry.exit === null ||
					(entry.exit &&
						Number.isFinite(entry.exit.at) &&
						(entry.exit.code === null || Number.isInteger(entry.exit.code))))
		);
		const living = known.filter(([, entry]) => alive(entry.pid));
		const info = WINDOWS
			? await this.inspect(living.map(([, entry]) => entry.pid))
			: null;
		for (const [key, entry] of known) {
			const batch = join(
				this.root,
				".state",
				"run",
				`${key.replace("/", "-")}.cmd`
			);
			const details = info?.get(entry.pid);
			const ours =
				alive(entry.pid) && this.recordedOwner(entry, details, batch);
			this.running.set(key, {
				...entry,
				exit: ours
					? null
					: (entry.exit ?? {
							at: Date.now(),
							code: this.recordedExit(key, entry),
						}),
			});
			if (isLauncherIdentity(entry.launcher) && ours) {
				// biome-ignore lint/performance/noAwaitInLoops: reconcile each persisted launch independently
				await this.reconcilePermission(key, entry.launcher.marker);
			}
		}
		await this.save();
	}

	private async reconcilePermission(
		key: string,
		marker: string
	): Promise<void> {
		// The hub may have exited after saving ownership but before granting permission.
		const files = launchFiles(join(this.root, ".state", "launch"), key, marker);
		const intent = await readIntent(files.intent);
		if (
			intent?.marker === marker &&
			(intent.state === "pending" ||
				(intent.state === "approved" && !existsSync(files.approval)))
		) {
			await cancelLaunch(files, intent);
		}
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

	/** Refresh these identities in the hub's existing batched process snapshot, including portless services. */
	identityPids(): number[] {
		return [...this.running.values()]
			.filter((entry) => entry.launcher && !entry.exit)
			.map((entry) => entry.pid);
	}

	/** Notes the processes that ended, with their exit codes; returns whether any did. */
	sweep(info?: Map<number, ProcessInfo>): boolean {
		let changed = false;
		for (const [key, entry] of this.running) {
			const details = info?.get(entry.pid);
			const replaced =
				isLauncherIdentity(entry.launcher) &&
				details?.created &&
				details.command &&
				!matchesLauncher(details, entry.launcher);
			if (entry.exit || (alive(entry.pid) && !replaced)) {
				continue;
			}
			const code = this.recordedExit(key, entry);
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

	async start(
		service: Service,
		wanted: () => void = () => undefined
	): Promise<Managed> {
		wanted();
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
		await rotateLog(log);
		await appendFile(
			log,
			`\n=== ${stamp()} · ${service.command} (в ${service.workdir})\n`
		);
		let pid = 0;
		if (WINDOWS) {
			return this.startDesktop(service, log, wanted);
		}
		pid = launchDetached(service, log, this.root, this.frameOrigin);
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

	/** Synchronous cancellation flag closes the discovery window before Hub waits for its serialized start. */
	async cancelPending(key: string): Promise<void> {
		const pending = this.pending.get(key);
		if (!pending) {
			return;
		}
		pending.cancelled = true;
		await cancelLaunch(pending.files, pending.intent);
	}

	private async startDesktop(
		service: Service,
		log: string,
		wanted: () => void
	): Promise<Managed> {
		const directory = join(this.root, ".state", "launch");
		await mkdir(directory, { recursive: true });
		const previous = await readIntent(
			launchFiles(directory, service.key, "").intent
		);
		let intent = previous?.state === "pending" ? previous : null;
		if (
			previous?.state === "approved" &&
			previous.marker !== this.get(service.key)?.launcher?.marker
		) {
			// Approved intent without its durable Managed record must be reconciled, never dispatched again.
			throw new Error(
				`${service.key}: approved desktop launch has no matching ownership record`
			);
		}
		if (!intent) {
			const marker = randomUUID();
			intent = {
				batch: join(
					this.root,
					".state",
					"run",
					`${fileName(service)}-${marker}.cmd`
				),
				marker,
				requestedAt: Date.now(),
				state: "pending",
			};
		}
		const files = launchFiles(directory, service.key, intent.marker);
		const pending = { cancelled: false, files, intent };
		this.pending.set(service.key, pending);
		const checkWanted = () => {
			wanted();
			if (this.pending.get(service.key)?.cancelled) {
				throw new Error(`${service.key}: desktop launch cancelled`);
			}
		};
		try {
			if (intent !== previous) {
				const exitFile = this.exitFileOf(service.key, intent.marker);
				await mkdir(dirname(exitFile), { recursive: true });
				await mkdir(dirname(intent.batch), { recursive: true });
				await writeFile(
					intent.batch,
					batchOf(service, log, exitFile, this.root, this.frameOrigin, {
						files,
						intent,
					})
				);
				checkWanted();
				await saveIntent(files.intent, intent);
				await this.retireAttempts(service.key, intent.marker);
				checkWanted();
				try {
					await this.dispatch(intent.batch, intent.marker);
				} catch {
					// ShellExecute may have dispatched before its caller timed out. Reconcile this marker only.
				}
			}
			const receipt = await awaitReceipt(
				files,
				intent,
				this.launchTimeoutMs,
				() => pending.cancelled
			);
			checkWanted();
			const info = (await this.inspect([receipt.pid])).get(receipt.pid);
			if (!matchesLauncher(info, receipt)) {
				throw new Error(
					`${service.key}: desktop launcher identity could not be verified`
				);
			}
			const entry: Managed = {
				command: service.command ?? "",
				cwd: service.workdir,
				exit: null,
				launcher: {
					batch: intent.batch,
					created: receipt.created,
					marker: intent.marker,
				},
				log,
				pid: receipt.pid,
				startedAt: intent.requestedAt,
				stopping: false,
			};
			this.running.set(service.key, entry);
			await this.save();
			checkWanted();
			await approveLaunch(files, intent, checkWanted);
			return entry;
		} catch (error) {
			await cancelLaunch(files, intent);
			const entry = this.get(service.key);
			if (pending.cancelled && entry?.launcher?.marker === intent.marker) {
				entry.stopping = true;
				await this.save();
			}
			throw error;
		} finally {
			this.pending.delete(service.key);
		}
	}

	/** Bounded per-attempt metadata; live or unidentifiable approved launchers retain their receipts. */
	private async retireAttempts(key: string, keep: string): Promise<void> {
		const directory = join(this.root, ".state", "run");
		const prefix = `${key.replace("/", "-")}-`;
		const markers = (await readdir(directory))
			.filter((name) => name.startsWith(prefix) && name.endsWith(".cmd"))
			.map((name) => name.slice(prefix.length, -4))
			.filter((marker) => marker !== keep && isLaunchMarker(marker));
		await Promise.all(markers.map((marker) => this.retireAttempt(key, marker)));
	}

	private async retireAttempt(key: string, marker: string): Promise<void> {
		const files = launchFiles(join(this.root, ".state", "launch"), key, marker);
		const batch = join(
			this.root,
			".state",
			"run",
			`${key.replace("/", "-")}-${marker}.cmd`
		);
		const receipt = await readReceipt(files.receipt, {
			batch,
			marker,
			requestedAt: 0,
			state: "cancelled",
		});
		if (!receipt && (existsSync(files.receipt) || existsSync(files.approval))) {
			return;
		}
		if (receipt && alive(receipt.pid)) {
			const info = (await this.inspect([receipt.pid])).get(receipt.pid);
			if (!(info?.created && info.command) || matchesLauncher(info, receipt)) {
				return;
			}
		}
		await Promise.all(
			[files.receipt, files.approval, this.exitFileOf(key, marker), batch].map(
				(path) => rm(path, { force: true })
			)
		);
	}

	/** Stops the process the hub started for a service. */
	async stop(service: Service): Promise<boolean> {
		let cancellationError: unknown;
		await this.cancelPending(service.key).catch((error: unknown) => {
			cancellationError = error;
		});
		const entry = this.get(service.key);
		if (!entry) {
			if (cancellationError) {
				throw cancellationError;
			}
			return false;
		}
		entry.stopping = true;
		let stopped = false;
		try {
			await this.save();
		} finally {
			// A storage failure must not prevent an explicit stop of our live process.
			if (!entry.exit && alive(entry.pid)) {
				await this.stopOwned(service.key, entry);
				stopped = true;
			}
			this.sweep();
		}
		if (cancellationError) {
			throw cancellationError;
		}
		return stopped;
	}

	private async stopOwned(key: string, entry: Managed): Promise<void> {
		const info = WINDOWS
			? (await this.inspect([entry.pid])).get(entry.pid)
			: undefined;
		const owned =
			entry.launcher === undefined
				? commandNamesBatch(
						info?.command ?? "",
						join(this.root, ".state", "run", `${key.replace("/", "-")}.cmd`)
					)
				: matchesLauncher(info, entry.launcher);
		if (WINDOWS && !owned) {
			throw new Error(
				`${key}: launcher identity changed or could not be verified; refusing to stop PID ${entry.pid}`
			);
		}
		await this.stopTree(entry.pid);
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
		// Keep exit and stop intent across hub restarts, including an unexpectedly dead launcher.
		const snapshot = `${JSON.stringify(Object.fromEntries(this.running), null, 2)}\n`;
		const saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.stateFile), { recursive: true });
				const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
				await writeFile(temporary, snapshot);
				await rename(temporary, this.stateFile);
			});
		this.saving = saving;
		return saving;
	}
}
