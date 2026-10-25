import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { catalogueSchema, type Service, servicesOf } from "../src/config";
import {
	batchOf,
	commandNamesBatch,
	detachedCommand,
	LOG_LIMIT_BYTES,
	logFileOf,
	type Managed,
	Processes,
	rotateLog,
	shellLaunchScript,
} from "../src/processes";

const root = mkdtempSync(join(tmpdir(), "devhub-"));
afterAll(() => rmSync(root, { force: true, recursive: true }));

function serviceWith(extra: Record<string, unknown>): Service {
	const [service] = servicesOf(
		catalogueSchema.parse({
			code: "F:/code",
			projects: [
				{
					id: "altay",
					name: "Алтай",
					path: "F:/code/altay",
					services: [{ id: "site", name: "Сайт", ...extra }],
				},
			],
		})
	);
	if (!service) {
		throw new Error("no service");
	}
	return service;
}

test("the batch file runs the command in its folder, with its environment, into the log", () => {
	const batch = batchOf(
		serviceWith({
			command: "npm run dev",
			env: { PORT: "3107", RATE: "100%" },
		}),
		"D:\\hub\\.logs\\altay-site.log",
		"D:\\hub\\.state\\exit\\altay-site.txt"
	);
	const lines = batch.split("\r\n");
	expect(lines).toContain("chcp 65001 > nul");
	expect(lines).toContain(`cd /d "${join("F:/code/altay", "")}"`);
	expect(lines).toContain('set "PORT=3107"');
	// A percent sign is doubled, or the batch file would read it as a variable.
	expect(lines).toContain('set "RATE=100%%"');
	expect(lines).toContain('set "NO_COLOR=1"');
	expect(lines).toContain('call :run >> "D:\\hub\\.logs\\altay-site.log" 2>&1');
	// The redirection comes first: `echo 3> file` would redirect stream 3 instead.
	expect(lines).toContain(
		'> "D:\\hub\\.state\\exit\\altay-site.txt" echo %errorlevel%'
	);
	// `call`, so npm (itself a batch file) returns and the exit code is written.
	expect(lines).toContain("call npm run dev");
});

test("a value a batch file cannot carry is refused", () => {
	expect(() =>
		batchOf(
			serviceWith({ command: "npm run dev", env: { TITLE: 'say "hi"' } }),
			"log",
			"exit"
		)
	).toThrow("кавычки");
});

test("development processes receive the hub identity and cannot override its development mode", () => {
	const batch = batchOf(
		serviceWith({
			command: "npm run dev",
			env: {
				DEVHUB_FRAME_ORIGIN: "http://unrelated.example:4700",
				DEVHUB_ROOT: "wrong",
				DEVHUB_SERVICE: "wrong",
				NODE_ENV: "production",
			},
		}),
		"log",
		"exit",
		"F:/code/devhub",
		"http://127.0.0.1:4712"
	);
	expect(batch).toContain('set "DEVHUB_FRAME_ORIGIN=http://127.0.0.1:4712"');
	expect(batch).toContain('set "DEVHUB_ROOT=F:/code/devhub"');
	expect(batch).toContain('set "DEVHUB_SERVICE=altay/site"');
	expect(batch).toContain('set "NODE_ENV=development"');
});

test("workspace binaries resolve from the service folder and project ancestors before the inherited path", () => {
	const batch = batchOf(
		serviceWith({
			command: "next dev",
			cwd: "apps/web",
			env: { PATH: "custom-tools" },
		}),
		"log",
		"exit",
		"F:/code/devhub"
	);
	const serviceBin = join("F:/code/altay/apps/web", "node_modules", ".bin");
	const rootBin = join("F:/code/altay", "node_modules", ".bin");
	expect(batch).toContain(serviceBin);
	expect(batch).toContain(rootBin);
	expect(batch.indexOf(serviceBin)).toBeLessThan(batch.indexOf(rootBin));
	expect(batch.indexOf(rootBin)).toBeLessThan(batch.indexOf("custom-tools"));
});

test("Windows launcher normalizes executable paths while preserving argument URLs", () => {
	const batch = batchOf(
		serviceWith({
			command: ".venv/Scripts/python.exe -m app --url https://example.com/api",
		}),
		"log",
		"exit"
	);
	expect(batch).toContain(
		"call .venv\\Scripts\\python.exe -m app --url https://example.com/api"
	);
});

test("the desktop shell is asked to run the batch file hidden, in its folder", () => {
	const script = shellLaunchScript("D:\\dev's hub\\.state\\run\\hub.cmd");
	// An apostrophe is doubled, or it would end the PowerShell string.
	expect(script).toContain(
		".ShellExecute('D:\\dev''s hub\\.state\\run\\hub.cmd', '', 'D:\\dev''s hub\\.state\\run', 'open', 0)"
	);
	// A failure is said in words: it never passes for a start.
	expect(
		script.endsWith("'started' } catch { 'failed: ' + $_.Exception.Message }")
	).toBe(true);
});

test("restart policies preserve the launcher owner and back off after each child exit", () => {
	const retry = serviceWith({
		command: "node worker.js",
		restart: "always",
		restartDelayMs: 30_000,
	});
	const batch = batchOf(retry, "log", "exit");
	expect(batch).toContain(":retry\r\ncall node worker.js");
	expect(batch).toContain('set "DEVHUB_EXIT_CODE=%errorlevel%"');
	expect(batch).toContain("Start-Sleep -Milliseconds 30000");
	expect(batch).toContain("goto retry");
	expect(batch).not.toContain('if "%DEVHUB_EXIT_CODE%"=="0"');
	const failing = batchOf(
		serviceWith({ command: "node worker.js", restart: "on-failure" }),
		"log",
		"exit"
	);
	expect(failing).toContain('if "%DEVHUB_EXIT_CODE%"=="0" exit /b 0');
	expect(detachedCommand(retry)).toContain("sleep 30");
	expect(detachedCommand(serviceWith({ command: "node worker.js" }))).toBe(
		"node worker.js"
	);
});

test("damaged process state is discarded safely", async () => {
	const isolated = mkdtempSync(join(root, "damaged-"));
	mkdirSync(join(isolated, ".state"));
	writeFileSync(join(isolated, ".state", "processes.json"), "null");
	const processes = new Processes(isolated);
	await processes.adopt();
	expect(processes.liveCount()).toBe(0);
});

test("a launcher that died while the hub was away retains its exit and explicit stop intent across adoption", async () => {
	const isolated = mkdtempSync(join(root, "dead-launcher-"));
	const state = join(isolated, ".state", "processes.json");
	mkdirSync(join(isolated, ".state"));
	writeFileSync(
		state,
		JSON.stringify({
			"altay/site": {
				command: "neutral-fixture",
				cwd: isolated,
				exit: null,
				log: join(isolated, "fixture.log"),
				pid: 2_147_483_647,
				startedAt: 1,
				stopping: false,
			},
		})
	);
	const first = new Processes(isolated);
	await first.adopt();
	expect(first.get("altay/site")?.exit?.code).toBeNull();
	expect(first.get("altay/site")?.stopping).toBe(false);
	const saved = JSON.parse(readFileSync(state, "utf8"));
	expect(saved["altay/site"].exit.at).toBeGreaterThan(1);
	expect(await first.stop(serviceWith({ command: "neutral-fixture" }))).toBe(
		false
	);
	const second = new Processes(isolated);
	await second.adopt();
	expect(second.get("altay/site")?.exit).toEqual(first.get("altay/site")?.exit);
	expect(second.get("altay/site")?.stopping).toBe(true);
	expect(second.liveCount()).toBe(0);
});

test("a normal launcher exit discovered during adoption retains its recorded zero exit code", async () => {
	const isolated = mkdtempSync(join(root, "normal-launcher-"));
	mkdirSync(join(isolated, ".state", "exit"), { recursive: true });
	writeFileSync(join(isolated, ".state", "exit", "altay-site.txt"), "0\n");
	writeFileSync(
		join(isolated, ".state", "processes.json"),
		JSON.stringify({
			"altay/site": {
				command: "neutral-fixture",
				cwd: isolated,
				exit: null,
				log: join(isolated, "fixture.log"),
				pid: 2_147_483_647,
				startedAt: 1,
				stopping: false,
			},
		})
	);
	const processes = new Processes(isolated);
	await processes.adopt();
	expect(processes.get("altay/site")?.exit?.code).toBe(0);
});

test("a failed state write still attempts the explicit stop and reports the persistence error", async () => {
	const isolated = mkdtempSync(join(root, "failed-stop-state-"));
	writeFileSync(
		join(isolated, ".state"),
		"a file prevents the state directory"
	);
	const stopped: number[] = [];
	const entry: Managed = {
		command: "neutral-fixture",
		cwd: isolated,
		exit: null,
		log: join(isolated, "fixture.log"),
		pid: process.pid,
		startedAt: 1,
		stopping: false,
	};
	class StopFixture extends Processes {
		override get(): Managed {
			return entry;
		}
	}
	const processes = new StopFixture(
		isolated,
		"",
		async (pid) => {
			stopped.push(pid);
			await Promise.resolve();
		},
		{
			inspect: async () =>
				new Map([
					[
						process.pid,
						{
							command: `cmd /c "${join(isolated, ".state", "run", "altay-site.cmd")}"`,
							name: "cmd.exe",
							parent: 0,
							pid: process.pid,
						},
					],
				]),
		}
	);
	await expect(
		processes.stop(serviceWith({ command: "neutral-fixture" }))
	).rejects.toThrow();
	expect(entry.stopping).toBe(true);
	expect(stopped).toEqual([process.pid]);
});

test("adoption requires the exact launcher path, including hub location", () => {
	const batch = "D:/My Hub/.state/run/app-api.cmd";
	expect(
		commandNamesBatch(
			'cmd.exe /c ""d:\\My Hub\\.state\\run\\app-api.cmd""',
			batch
		)
	).toBe(true);
	expect(
		commandNamesBatch('cmd.exe /c "D:/other/.state/run/app-api.cmd"', batch)
	).toBe(false);
	expect(
		commandNamesBatch(
			'cmd.exe /c "D:/My Hub/.state/run/app-api.cmd.exe"',
			batch
		)
	).toBe(false);
});

test("the log is read in whole lines, from its last part and then on from where it stopped", async () => {
	const service = serviceWith({ command: "npm run dev" });
	const log = logFileOf(root, service);
	mkdirSync(join(root, ".logs"), { recursive: true });
	writeFileSync(log, "первая строка\nвторая стр");
	const processes = new Processes(root);

	const first = await processes.tail(service);
	expect(first.reset).toBe(true);
	expect(first.text).toBe("первая строка\n");

	writeFileSync(log, "первая строка\nвторая строка\nтретья\n");
	const second = await processes.tail(service, first.offset);
	expect(second.reset).toBe(false);
	expect(second.text).toBe("вторая строка\nтретья\n");

	const nothing = await processes.tail(service, second.offset);
	expect(nothing.text).toBe("");

	// The log was moved aside and began again: its last part comes afresh.
	writeFileSync(log, "заново\n");
	const again = await processes.tail(service, second.offset);
	expect(again.reset).toBe(true);
	expect(again.text).toBe("заново\n");
});

/** A service log in a folder of its own. */
function freshLog(): { log: string; logs: string } {
	const log = logFileOf(
		mkdtempSync(join(root, "rotate-")),
		serviceWith({ command: "npm run dev" })
	);
	mkdirSync(dirname(log), { recursive: true });
	return { log, logs: dirname(log) };
}

/** A log just over the limit that ends with these lines. */
function writeLargeLog(log: string, lines: string): void {
	writeFileSync(
		log,
		Buffer.concat([
			Buffer.alloc(LOG_LIMIT_BYTES, "a"),
			Buffer.from(`\n${lines}`),
		])
	);
}

test("a log over the limit is set aside under the time of the start; a smaller one stays", async () => {
	const { log, logs } = freshLog();
	writeFileSync(log, "немного\n");
	await rotateLog(log, new Date(2026, 9, 25, 9, 31, 40));
	expect(readdirSync(logs)).toEqual(["altay-site.log"]);

	writeLargeLog(log, "=== 25.10.2026, 09:31:39 · остановлен из пульта\n");
	await rotateLog(log, new Date(2026, 9, 25, 9, 31, 40));
	// A stop from the page is not a crash.
	expect(readdirSync(logs)).toEqual(["altay-site.20261025-093140.log"]);
});

test("rotation keeps the newest three set-aside logs and the newest crash, however many come after it", async () => {
	const { log, logs } = freshLog();
	writeFileSync(join(logs, "altay-site-two.20261001-000000.log"), "сосед\n");
	writeLargeLog(log, "=== 24.10.2026, 22:56:08 · завершился с кодом 1\n");
	await rotateLog(log, new Date(2026, 9, 25, 9, 31, 40));
	for (const hour of [10, 11, 12, 13]) {
		writeLargeLog(log, "=== 25.10.2026 · остановлен из пульта\n");
		// biome-ignore lint/performance/noAwaitInLoops: rotations happen one after another
		await rotateLog(log, new Date(2026, 9, 25, hour));
	}
	expect(readdirSync(logs).sort()).toEqual([
		"altay-site-two.20261001-000000.log",
		"altay-site.20261025-093140.crash.log",
		"altay-site.20261025-110000.log",
		"altay-site.20261025-120000.log",
		"altay-site.20261025-130000.log",
	]);
	expect(
		readFileSync(join(logs, "altay-site.20261025-093140.crash.log"), "utf8")
	).toEndWith("· завершился с кодом 1\n");

	// A newer crash takes the place of the older one.
	writeLargeLog(log, "=== 25.10.2026, 14:00:00 · процесс завершился\n");
	await rotateLog(log, new Date(2026, 9, 25, 14));
	expect(readdirSync(logs).sort()).toEqual([
		"altay-site-two.20261001-000000.log",
		"altay-site.20261025-120000.log",
		"altay-site.20261025-130000.log",
		"altay-site.20261025-140000.crash.log",
	]);
});

test("a crash line cut between two reads of a large log is still found", async () => {
	const { log, logs } = freshLog();
	const prefix = "=== 24.10.2026, 22:56:08 ";
	// The log is read a mebibyte at a time: the first read ends inside «· завершился».
	writeFileSync(
		log,
		Buffer.concat([
			Buffer.alloc(1024 * 1024 - prefix.length - 4, "a"),
			Buffer.from(`${prefix}· завершился с кодом 1\n`),
			Buffer.alloc(LOG_LIMIT_BYTES, "b"),
		])
	);
	await rotateLog(log, new Date(2026, 9, 25, 9, 31, 40));
	expect(readdirSync(logs)).toEqual(["altay-site.20261025-093140.crash.log"]);
});

test("a log the earlier single rotation set aside joins the others under the time it was last written", async () => {
	const { log, logs } = freshLog();
	writeFileSync(
		`${log}.old`,
		"=== 24.10.2026, 22:56:08 · завершился с кодом 1\n"
	);
	const written = new Date(2026, 9, 25, 16, 4, 9);
	utimesSync(`${log}.old`, written, written);
	writeFileSync(log, "немного\n");
	await rotateLog(log);
	expect(readdirSync(logs).sort()).toEqual([
		"altay-site.20261025-160409.crash.log",
		"altay-site.log",
	]);
});
