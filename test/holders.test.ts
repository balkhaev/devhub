import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
	type FolderProcesses,
	holdersOf,
	ownChain,
	type ProcessRow,
	type ProcessSurvey,
	removeFolder,
	systemProcesses,
} from "../src/holders";

const WINDOWS = process.platform === "win32";
const fixtures: string[] = [];
const children: ChildProcess[] = [];
const home = process.cwd();

function fixture(): string {
	const base = mkdtempSync(join(tmpdir(), "devhub-holders-test-"));
	fixtures.push(base);
	return base;
}

/**
 * A process that does nothing but work in a folder. A new process opens its folder a moment after it is created,
 * so this waits for its first line.
 */
async function idleIn(folder: string): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
		{ cwd: folder, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
	);
	children.push(child);
	if (child.stdout) {
		await once(child.stdout, "data");
	}
	return child;
}

const exited = (child: ChildProcess): boolean =>
	child.exitCode !== null || child.signalCode !== null;

const untilExited = (child: ChildProcess): Promise<boolean> =>
	new Promise((done) => {
		if (exited(child)) {
			done(true);
			return;
		}
		const timer = setTimeout(() => done(false), 5000);
		child.once("exit", () => {
			clearTimeout(timer);
			done(true);
		});
	});

const row = (
	pid: number,
	parent: number,
	extra: Partial<ProcessRow> = {}
): ProcessRow => ({
	cwd: null,
	exe: null,
	name: `p${pid}.exe`,
	parent,
	pid,
	started: pid,
	...extra,
});

const survey = (
	processes: ProcessRow[],
	fileUsers: number[] = []
): ProcessSurvey => ({ fileUsers, processes });

afterEach(async () => {
	process.chdir(home);
	await Promise.all(
		children.splice(0).map((child) => {
			child.kill();
			return untilExited(child);
		})
	);
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-holders-test-")
		) {
			throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, maxRetries: 5, recursive: true });
	}
});

test("a holder works in the folder, runs a program from it or keeps one of its files open", () => {
	const folder = join(tmpdir(), "tasks", "topic");
	const found = holdersOf(
		folder,
		survey(
			[
				row(10, 1, { cwd: `${folder}${sep}` }),
				row(11, 1, { cwd: join(folder, "apps", "web") }),
				row(12, 1, { exe: join(folder, "node_modules", ".bin", "tool.exe") }),
				row(13, 1),
				// A neighbour whose name only begins the same way, the parent folder and unrelated work.
				row(14, 1, { cwd: `${folder}-2` }),
				row(15, 1, { cwd: dirname(folder) }),
				row(16, 1, { cwd: tmpdir() }),
				// The kernel is never a holder a command could end.
				row(4, 0, { cwd: folder, name: "System" }),
			],
			[13]
		)
	);
	expect(found.map((holder) => holder.pid)).toEqual([10, 11, 12, 13]);
	expect(found[0]).toEqual({ name: "p10.exe", pid: 10 });
});

test.skipIf(!WINDOWS)("Windows spells one folder in many ways", () => {
	const folder = "F:\\Worktrees\\Studio\\Task";
	expect(
		holdersOf(
			folder,
			survey([row(10, 1, { cwd: "f:/worktrees/studio/task/" })])
		)
	).toHaveLength(1);
});

test("the session of a command is the command and the processes it was started from", () => {
	const table = survey([
		row(100, 1, { started: 1000 }),
		row(200, 100, { started: 2000 }),
		row(300, 200, { started: 3000 }),
		row(301, 200, { started: 3000 }),
		// PID 50 was the parent of 400 once; the process that has it now started later.
		row(50, 1, { started: 9000 }),
		row(400, 50, { started: 4000 }),
	]);
	expect([...ownChain(table, 300)].sort()).toEqual([100, 200, 300]);
	expect([...ownChain(table, 400)]).toEqual([400]);
	// An unknown command still protects itself.
	expect([...ownChain(table, 999)]).toEqual([999]);
});

test("a free folder goes with read-only files; a link goes as a link", () => {
	const base = fixture();
	const outside = join(base, "outside");
	const folder = join(base, "task");
	mkdirSync(join(folder, "deep", "deeper"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, "keep.txt"), "kept\n");
	writeFileSync(join(folder, "deep", "deeper", "file.txt"), "gone\n");
	writeFileSync(join(folder, "locked.txt"), "gone\n");
	chmodSync(join(folder, "locked.txt"), 0o444);
	symlinkSync(outside, join(folder, "deep", "link"), "junction");
	const asked: FolderProcesses = {
		end: () => {
			throw new Error("nothing to end");
		},
		survey: () => {
			throw new Error("nobody to ask about");
		},
	};

	expect(removeFolder(folder, { kill: true, processes: asked })).toEqual({
		ended: [],
		holders: [],
		own: false,
		removed: true,
	});
	expect(existsSync(folder)).toBe(false);
	expect(existsSync(join(outside, "keep.txt"))).toBe(true);
});

test.skipIf(!WINDOWS)(
	"a folder a process works in is reported, and removed once that process is ended",
	async () => {
		const folder = join(fixture(), "task");
		mkdirSync(join(folder, "apps"), { recursive: true });
		writeFileSync(join(folder, "apps", "file.txt"), "tracked\n");
		const child = await idleIn(folder);

		const kept = removeFolder(folder, { kill: false });
		expect(kept.removed).toBe(false);
		expect(kept.ended).toEqual([]);
		expect(kept.holders.map((holder) => holder.pid)).toEqual([
			child.pid as number,
		]);
		expect(exited(child)).toBe(false);
		// What nobody holds is already gone.
		expect(existsSync(join(folder, "apps"))).toBe(false);

		const freed = removeFolder(folder, { kill: true });
		expect(freed.removed).toBe(true);
		expect(freed.ended.map((holder) => holder.pid)).toEqual([
			child.pid as number,
		]);
		expect(existsSync(folder)).toBe(false);
		expect(await untilExited(child)).toBe(true);
	},
	60_000
);

test.skipIf(!WINDOWS)(
	"the session a command runs in is never ended, and neither is anyone else then",
	async () => {
		const folder = join(fixture(), "task");
		mkdirSync(folder);
		const other = await idleIn(folder);
		process.chdir(folder);

		const kept = removeFolder(folder, { kill: true });
		expect(kept).toMatchObject({ ended: [], own: true, removed: false });
		expect(kept.holders.map((holder) => holder.pid).sort()).toEqual(
			[process.pid, other.pid as number].sort()
		);
		await delay(200);
		expect(exited(other)).toBe(false);

		process.chdir(home);
		const freed = removeFolder(folder, { kill: true });
		expect(freed.removed).toBe(true);
		expect(freed.own).toBe(false);
		expect(await untilExited(other)).toBe(true);
	},
	60_000
);

test.skipIf(!WINDOWS)(
	"Windows' own processes are named and left alone",
	() => {
		const folder = join(fixture(), "task");
		mkdirSync(folder);
		process.chdir(folder);
		const ended: number[] = [];
		const shell = row(4242, 1, { cwd: folder, name: "Explorer.EXE" });

		const kept = removeFolder(folder, {
			kill: true,
			processes: {
				end: (pid) => ended.push(pid),
				survey: () => survey([shell]),
			},
		});
		expect(kept).toEqual({
			ended: [],
			holders: [{ name: "Explorer.EXE", pid: 4242 }],
			own: false,
			removed: false,
		});
		expect(ended).toEqual([]);
	},
	30_000
);

test.skipIf(!WINDOWS)(
	"the computer names this test among the processes, with its folder and its parent",
	() => {
		const table = systemProcesses.survey([]);
		const self = table.processes.find((entry) => entry.pid === process.pid);
		expect(self?.cwd && resolve(self.cwd).toLowerCase()).toBe(
			resolve(process.cwd()).toLowerCase()
		);
		expect(self?.parent).toBe(process.ppid);
		expect(ownChain(table).size).toBeGreaterThan(1);
	},
	60_000
);
