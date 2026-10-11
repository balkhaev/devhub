import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { Catalogue } from "../src/config";
import { StageProject } from "../src/stage";
import { formatTidy, machineTidy } from "../src/tidy";

const fixtures: string[] = [];

function git(folder: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", folder, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `Fixture Git failed: ${args[0]}`);
	}
	return result.stdout.trimEnd();
}

/** A machine with one policy project `demo`, one project without a policy and a data folder. */
function machine(): { catalogue: Catalogue; data: string; demo: string } {
	const base = mkdtempSync(join(tmpdir(), "devhub-tidy-test-"));
	fixtures.push(base);
	const demo = join(base, "code", "demo");
	const plain = join(base, "code", "plain");
	const data = join(base, "data");
	for (const folder of [join(demo, ".devhub"), plain, data]) {
		mkdirSync(folder, { recursive: true });
	}
	git(demo, "init", "--initial-branch=main");
	git(demo, "config", "user.name", "DevHub fixture");
	git(demo, "config", "user.email", "fixture@example.test");
	git(demo, "config", "commit.gpgsign", "false");
	writeFileSync(
		join(demo, ".devhub", "worktree.json"),
		`${JSON.stringify({
			checks: ["node --version"],
			mode: "mvp",
			releaseBranch: "main",
			remote: null,
			stageBranch: "stage",
			version: 1,
			worktreeRoot: "../../worktrees/demo",
		})}\n`
	);
	git(demo, "add", ".");
	git(demo, "commit", "-m", "Initial fixture");
	const project = (id: string, path: string) => ({
		id,
		launch: {},
		name: id,
		path,
		services: [],
	});
	return {
		catalogue: {
			aliases: {},
			code: join(base, "code"),
			data,
			discover: [],
			exclude: [],
			port: 4700,
			projects: [project("demo", demo), project("plain", plain)],
		},
		data,
		demo,
	};
}

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-tidy-test-")
		) {
			throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

test("one report names leftovers of every project and of the shared data folder", () => {
	const { catalogue, data, demo } = machine();
	git(demo, "branch", "codex/merged");
	for (const entry of [
		"demo",
		"Plain",
		"Old-backup-20261010",
		"_trash-20261011",
	]) {
		mkdirSync(join(data, entry));
	}
	mkdirSync(join(dirname(dirname(demo)), "worktrees", "demo", "leftover"), {
		recursive: true,
	});

	const report = machineTidy(catalogue);
	expect(report.skipped).toEqual(["plain"]);
	expect(report.data.unowned).toEqual(["Old-backup-20261010"]);
	expect(report.data.trash).toEqual(["_trash-20261011"]);
	const text = formatTidy(report);
	expect(text).toContain("слитые ветки закрытых задач: 1");
	expect(text).toContain("папка без worktree:");
	expect(text).toContain("вне папок проектов: Old-backup-20261010");
	expect(text).toContain("ждёт удаления: _trash-20261011");
	expect(text).toContain("без политики worktree: plain");

	const applied = machineTidy(catalogue, { apply: true, project: "demo" });
	expect(applied.projects[0]?.applied?.branches).toEqual(["codex/merged"]);
	expect(git(demo, "for-each-ref", "refs/heads/codex")).toBe("");
	// A single project never reports the shared folder.
	expect(applied.data.unowned).toEqual([]);
	rmSync(join(dirname(dirname(demo)), "worktrees"), {
		force: true,
		recursive: true,
	});
	expect(formatTidy(machineTidy(catalogue, { project: "demo" }))).toBe(
		"чисто: demo\n"
	);
}, 30_000);

test("a project in the middle of another stage command is reported, not cleaned", () => {
	const { catalogue, demo } = machine();
	git(demo, "branch", "codex/merged");
	const release = new StageProject(demo).acquireLock();
	try {
		const report = machineTidy(catalogue, { apply: true });
		expect(report.busy).toEqual(["demo"]);
		expect(report.projects[0]?.merged).toHaveLength(1);
		expect(formatTidy(report)).toContain("заняты другой задачей");
	} finally {
		release();
	}
	expect(machineTidy(catalogue, { apply: true }).busy).toEqual([]);
	expect(git(demo, "for-each-ref", "refs/heads/codex")).toBe("");
}, 30_000);
