import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { acquireFileLock, type ProcessProbe } from "../src/stage-lock";

const LABEL = "проект занят другим stage-процессом";
const folders: string[] = [];

function lockPath(): string {
	const folder = mkdtempSync(join(tmpdir(), "devhub-stage-lock-"));
	folders.push(folder);
	return join(folder, "project.lock");
}

function probe(
	alive: boolean,
	startedAt?: number
): ProcessProbe & { calls: number } {
	const result = {
		alive: () => {
			result.calls += 1;
			return alive;
		},
		calls: 0,
		startedAt: () => startedAt,
	};
	return result;
}

const holder = (pid: number, createdAt: number) =>
	`${JSON.stringify({ createdAt, nonce: "other", pid })}\n`;

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { force: true, recursive: true });
	}
});

describe("stage lock recovery", () => {
	test("a lock of a finished process is replaced and released by its new owner", () => {
		const file = lockPath();
		writeFileSync(file, "54264\n");
		const release = acquireFileLock(file, LABEL, probe(false));
		expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
		expect(existsSync(`${file}.recover`)).toBe(false);
		release();
		expect(existsSync(file)).toBe(false);
	});

	test("a live holder keeps its lock, also when its start time is unknown", () => {
		const file = lockPath();
		const text = holder(54_264, Date.now() - 5000);
		writeFileSync(file, text);
		for (const live of [
			probe(true, Date.now() - 60_000),
			probe(true, undefined),
		]) {
			expect(() => acquireFileLock(file, LABEL, live)).toThrow(
				`${LABEL}: ${file} (PID 54264)`
			);
			expect(readFileSync(file, "utf8")).toBe(text);
		}
	});

	test("a PID reused by a process started after the lock does not hold it", () => {
		const file = lockPath();
		writeFileSync(file, holder(54_264, Date.now() - 60_000));
		const release = acquireFileLock(file, LABEL, probe(true, Date.now()));
		expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
		release();
		expect(existsSync(file)).toBe(false);
	});

	test("the own process is busy without asking the system", () => {
		const file = lockPath();
		const check = probe(false);
		const release = acquireFileLock(file, LABEL, check);
		expect(() => acquireFileLock(file, LABEL, check)).toThrow(LABEL);
		expect(check.calls).toBe(0);
		release();
		expect(existsSync(file)).toBe(false);
	});

	test("a lock without a PID is abandoned only after the grace period", () => {
		const file = lockPath();
		writeFileSync(file, "");
		expect(() => acquireFileLock(file, LABEL, probe(false))).toThrow(LABEL);
		expect(readFileSync(file, "utf8")).toBe("");
		const old = new Date(Date.now() - 120_000);
		utimesSync(file, old, old);
		acquireFileLock(file, LABEL, probe(false))();
		expect(existsSync(file)).toBe(false);
	});

	test("a recovery in progress elsewhere blocks a second recovery", () => {
		const file = lockPath();
		writeFileSync(file, "54264\n");
		writeFileSync(`${file}.recover`, holder(54_265, Date.now()));
		const recovering: ProcessProbe = {
			alive: (pid) => pid === 54_265,
			startedAt: () => 0,
		};
		expect(() => acquireFileLock(file, LABEL, recovering)).toThrow(
			"блокировку уже восстанавливает другой процесс"
		);
		expect(() => acquireFileLock(file, LABEL, probe(false))).toThrow(
			"восстановление блокировки прервано (PID 54265 завершён)"
		);
		expect(readFileSync(file, "utf8")).toBe("54264\n");
		expect(existsSync(`${file}.recover`)).toBe(true);
	});

	test("release never removes a lock that another process owns now", () => {
		const file = lockPath();
		const release = acquireFileLock(file, LABEL, probe(false));
		const other = holder(54_264, Date.now());
		writeFileSync(file, other);
		release();
		expect(readFileSync(file, "utf8")).toBe(other);
	});

	test("the system probe tells a running holder from a finished one", async () => {
		const file = lockPath();
		const finished = spawnSync(process.execPath, ["-e", "0"]);
		expect(finished.pid).toBeGreaterThan(0);
		writeFileSync(file, `${finished.pid}\n`);
		acquireFileLock(file, LABEL)();
		expect(existsSync(file)).toBe(false);

		const running = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 60000)"],
			{
				stdio: "ignore",
				windowsHide: true,
			}
		);
		try {
			await delay(500);
			const text = holder(running.pid as number, Date.now());
			writeFileSync(file, text);
			expect(() => acquireFileLock(file, LABEL)).toThrow(
				`(PID ${running.pid})`
			);
			expect(readFileSync(file, "utf8")).toBe(text);
		} finally {
			running.kill();
		}
	}, 30_000);
});
