import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { lastUse } from "../src/folder-use";
import type { ProcessSurvey } from "../src/holders";

const NOT_ALPHANUMERIC = /[^a-zA-Z0-9]/g;
const HOUR = 60 * 60 * 1000;
const nobody: ProcessSurvey = { fileUsers: [], processes: [] };
const fixtures: string[] = [];

/** A folder last changed ten hours ago, and an empty place for session logs. */
function fixture(): {
	base: string;
	folder: string;
	logs: string;
	start: number;
} {
	const base = mkdtempSync(join(tmpdir(), "devhub-use-test-"));
	fixtures.push(base);
	const folder = join(base, "tasks", "topic");
	const logs = join(base, "logs");
	mkdirSync(folder, { recursive: true });
	mkdirSync(logs);
	const start = Date.now() - 10 * HOUR;
	utimesSync(folder, new Date(start), new Date(start));
	return { base, folder, logs, start };
}

/** A session that works in `folder` wrote to its log `hoursAgo` hours ago. */
function sessionLog(logs: string, folder: string, hoursAgo: number): number {
	const file = join(logs, folder.replace(NOT_ALPHANUMERIC, "-"), "log.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{}\n");
	const at = Date.now() - hoursAgo * HOUR;
	utimesSync(file, new Date(at), new Date(at));
	return at;
}

const near = (actual: number, expected: number): boolean =>
	Math.abs(actual - expected) < 5000;

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-use-test-")
		) {
			throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

test("a folder nobody touched was last in use when it last changed", () => {
	const { folder, logs, start } = fixture();
	expect(near(lastUse(folder, nobody, logs), start)).toBe(true);
	// A place for logs that is not there says nothing.
	expect(near(lastUse(folder, nobody, join(logs, "missing")), start)).toBe(
		true
	);
});

test("a session's log counts for its own folder and for folders inside it, not for others", () => {
	const { base, folder, logs, start } = fixture();
	sessionLog(logs, join(base, "tasks", "other"), 1);
	sessionLog(logs, dirname(folder), 1);
	expect(near(lastUse(folder, nobody, logs), start)).toBe(true);

	const own = sessionLog(logs, folder, 5);
	expect(near(lastUse(folder, nobody, logs), own)).toBe(true);
	const inside = sessionLog(logs, join(folder, "apps", "web"), 2);
	expect(near(lastUse(folder, nobody, logs), inside)).toBe(true);
});

test("a process that began to work in the folder is a use of it", () => {
	const { folder, logs, start } = fixture();
	const began = Date.now() - 3 * HOUR;
	const survey: ProcessSurvey = {
		fileUsers: [],
		processes: [
			{
				cwd: folder,
				exe: null,
				name: "bash.exe",
				parent: 1,
				pid: 100,
				started: began,
			},
			// Elsewhere, and a holder whose start Windows did not tell.
			{
				cwd: tmpdir(),
				exe: null,
				name: "node.exe",
				parent: 1,
				pid: 101,
				started: Date.now(),
			},
			{
				cwd: folder,
				exe: null,
				name: "claude.exe",
				parent: 1,
				pid: 102,
				started: null,
			},
		],
	};
	expect(near(lastUse(folder, survey, logs), began)).toBe(true);
	expect(near(lastUse(folder, nobody, logs), start)).toBe(true);
});
