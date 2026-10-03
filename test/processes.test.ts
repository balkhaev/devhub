import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalogueSchema, type Service, servicesOf } from "../src/config";
import {
	batchOf,
	commandNamesBatch,
	detachedCommand,
	logFileOf,
	Processes,
} from "../src/processes";

const root = mkdtempSync(join(tmpdir(), "devhub-"));
afterAll(() => rmSync(root, { force: true, recursive: true }));

function serviceWith(extra: Record<string, unknown>): Service {
	const [service] = servicesOf(
		catalogueSchema.parse({
			code: "D:/code",
			projects: [
				{
					id: "altay",
					name: "Алтай",
					path: "D:/code/altay",
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
	expect(lines).toContain(`cd /d "${join("D:/code/altay", "")}"`);
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
		"D:/code/devhub",
		"http://127.0.0.1:4712"
	);
	expect(batch).toContain('set "DEVHUB_FRAME_ORIGIN=http://127.0.0.1:4712"');
	expect(batch).toContain('set "DEVHUB_ROOT=D:/code/devhub"');
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
		"D:/code/devhub"
	);
	const serviceBin = join("D:/code/altay/apps/web", "node_modules", ".bin");
	const rootBin = join("D:/code/altay", "node_modules", ".bin");
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
