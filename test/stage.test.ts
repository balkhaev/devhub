import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { StageProject } from "../src/stage";

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

function fixture(options: { committed?: boolean; checks?: string[] } = {}) {
	const base = mkdtempSync(join(tmpdir(), "devhub-stage-test-"));
	fixtures.push(base);
	const folder = join(base, "project");
	mkdirSync(folder);
	git(folder, "init", "--initial-branch=main");
	git(folder, "config", "user.name", "DevHub fixture");
	git(folder, "config", "user.email", "fixture@example.test");
	git(folder, "config", "commit.gpgsign", "false");
	git(folder, "config", "core.autocrlf", "false");
	const hooks = join(base, "hooks");
	mkdirSync(hooks);
	git(folder, "config", "core.hooksPath", hooks);
	mkdirSync(join(folder, ".devhub"));
	writeFileSync(
		join(folder, ".devhub", "worktree.json"),
		`${JSON.stringify({
			checks: options.checks ?? ["node check.mjs"],
			releaseBranch: "main",
			stageBranch: "stage",
			version: 1,
			worktreeRoot: "../.worktrees/project",
		})}\n`
	);
	writeFileSync(join(folder, ".gitignore"), "ignored/\nfailure.flag\n");
	writeFileSync(join(folder, "source.txt"), "initial\n");
	writeFileSync(
		join(folder, "check.mjs"),
		'import { existsSync } from "node:fs";\nif (process.env.DEVHUB_STAGE !== "1" || existsSync("failure.flag")) process.exit(2);\n'
	);
	if (options.committed !== false) {
		git(folder, "add", ".");
		git(folder, "commit", "-m", "Initial fixture");
	}
	const project = new StageProject(folder, join(base, "state"));
	return { base, folder, project };
}

function commitSource(folder: string, value: string): string {
	writeFileSync(join(folder, "source.txt"), `${value}\n`);
	git(folder, "add", "source.txt");
	git(folder, "commit", "-m", "Change fixture source");
	return git(folder, "rev-parse", "HEAD");
}

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-stage-test-")
		) {
			throw new Error(
				`Refuse cleanup outside disposable test fixture: ${absolute}`
			);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

describe("canonical staging with real disposable Git repositories", () => {
	test("initialization preserves committed HEAD, index, dirty files and untracked work", () => {
		const { folder, project } = fixture();
		const head = git(folder, "rev-parse", "HEAD");
		writeFileSync(join(folder, "source.txt"), "staged\n");
		git(folder, "add", "source.txt");
		writeFileSync(join(folder, "source.txt"), "unstaged\n");
		writeFileSync(join(folder, "draft.txt"), "untracked work\n");
		const status = git(folder, "status", "--porcelain");
		project.init();
		expect(project.branch()).toBe("stage");
		expect(project.head()).toBe(head);
		expect(git(folder, "rev-parse", "main")).toBe(head);
		expect(git(folder, "status", "--porcelain")).toBe(status);
		expect(git(folder, "show", ":source.txt")).toBe("staged");
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(folder, "draft.txt"), "utf8")).toBe(
			"untracked work\n"
		);
	});

	test("unborn initialization preserves staged and untracked files without inventing a commit", () => {
		const { folder, project } = fixture({ committed: false });
		git(folder, "add", "source.txt");
		writeFileSync(join(folder, "draft.txt"), "unborn draft\n");
		const status = git(folder, "status", "--porcelain");
		project.init();
		expect(project.branch()).toBe("stage");
		expect(project.head()).toBeNull();
		expect(git(folder, "status", "--porcelain")).toBe(status);
		expect(git(folder, "show", ":source.txt")).toBe("initial");
		expect(readFileSync(join(folder, "draft.txt"), "utf8")).toBe(
			"unborn draft\n"
		);
	});

	test("existing stage on another commit cannot switch or overwrite local work", () => {
		const { folder, project } = fixture();
		git(folder, "branch", "stage");
		const head = commitSource(folder, "new main");
		writeFileSync(join(folder, "source.txt"), "dirty main\n");
		expect(() => project.init()).toThrow(
			"stage уже существует на другом коммите"
		);
		expect(project.branch()).toBe("main");
		expect(project.head()).toBe(head);
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"dirty main\n"
		);
	});

	test("unborn checkout cannot attach an already existing unrelated stage commit", () => {
		const { folder, project } = fixture();
		const policy = readFileSync(
			join(folder, ".devhub", "worktree.json"),
			"utf8"
		);
		git(folder, "branch", "stage");
		git(folder, "switch", "--orphan", "empty");
		mkdirSync(join(folder, ".devhub"));
		writeFileSync(join(folder, ".devhub", "worktree.json"), policy);
		writeFileSync(join(folder, "draft.txt"), "orphan working files\n");
		expect(project.head()).toBeNull();
		expect(() => project.init()).toThrow();
		expect(project.branch()).toBe("empty");
		expect(project.head()).toBeNull();
		expect(readFileSync(join(folder, "draft.txt"), "utf8")).toBe(
			"orphan working files\n"
		);
	});

	test("create reuses the same registered topic checkout and preserves its unfinished edits", () => {
		const { project } = fixture();
		project.init();
		const tree = project.create("reuse-task");
		expect(project.create("codex/reuse-task")).toBe(tree);
		writeFileSync(join(tree, "draft.txt"), "unfinished reused work\n");
		expect(project.create("reuse-task")).toBe(tree);
		expect(readFileSync(join(tree, "draft.txt"), "utf8")).toBe(
			"unfinished reused work\n"
		);
		expect(project.worktrees()).toHaveLength(2);
	});

	test("task starts at stage, integration checks canonical source and leaves release branch intact", () => {
		const { folder, project } = fixture();
		const releaseHead = git(folder, "rev-parse", "HEAD");
		project.init();
		const tree = project.create("feature/topic");
		expect(git(tree, "symbolic-ref", "--short", "HEAD")).toBe(
			"codex/feature/topic"
		);
		expect(git(tree, "rev-parse", "HEAD")).toBe(releaseHead);
		const taskHead = commitSource(tree, "integrated feature");
		project.integrate(tree);
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"integrated feature\n"
		);
		expect(git(folder, "rev-parse", "main")).toBe(releaseHead);
		expect(project.head()).not.toBe(taskHead);
		expect(project.status()).toMatchObject({
			branch: "stage",
			checked: true,
			dirty: false,
			releaseReady: true,
		});
		const record = JSON.parse(readFileSync(project.stateFile, "utf8"));
		expect(record.head).toBe(project.head());
		expect(git(folder, "merge-base", "--is-ancestor", taskHead, "stage")).toBe(
			""
		);
	});

	test("dirty canonical checkout blocks creating and integrating worktrees", () => {
		const { folder, project } = fixture();
		project.init();
		writeFileSync(join(folder, "source.txt"), "unsaved canonical work\n");
		expect(() => project.create("task")).toThrow("есть локальные изменения");
		expect(() => project.integrate("main")).toThrow("есть локальные изменения");
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"unsaved canonical work\n"
		);
	});

	test("integration rejects dirty task checkouts through both path and branch", () => {
		const { project } = fixture();
		project.init();
		const tree = project.create("unfinished");
		writeFileSync(join(tree, "source.txt"), "unfinished task\n");
		const head = project.head();
		expect(() => project.integrate(tree)).toThrow("есть локальные изменения");
		expect(() => project.integrate("codex/unfinished")).toThrow(
			"есть локальные изменения"
		);
		expect(project.head()).toBe(head);
		expect(readFileSync(join(tree, "source.txt"), "utf8")).toBe(
			"unfinished task\n"
		);
	});

	test("source and index changes invalidate a successful final-check record", () => {
		const { folder, project } = fixture();
		project.init();
		project.check();
		expect(project.status().releaseReady).toBe(true);
		writeFileSync(join(folder, "source.txt"), "changed after check\n");
		expect(project.status().checked).toBe(false);
		git(folder, "add", "source.txt");
		expect(project.status().checked).toBe(false);
	});

	test("untracked file bytes participate in checks without making dirty stage release-ready", () => {
		const { folder, project } = fixture();
		project.init();
		const draft = join(folder, "draft.txt");
		writeFileSync(draft, "first draft\n");
		project.check();
		expect(project.status()).toMatchObject({
			checked: true,
			dirty: true,
			releaseReady: false,
		});
		writeFileSync(draft, "second draft\n");
		expect(project.status().checked).toBe(false);
	});

	test("ignored environment edits invalidate final checks in canonical root and application folders", () => {
		const { folder, project } = fixture();
		writeFileSync(
			join(folder, ".gitignore"),
			"ignored/\nfailure.flag\n.env*\n"
		);
		const web = join(folder, "apps", "web");
		mkdirSync(web, { recursive: true });
		writeFileSync(
			join(web, "package.json"),
			'{"name":"offline-web-fixture","private":true}\n'
		);
		git(folder, "add", ".");
		git(folder, "commit", "-m", "Fixture local environment inputs");
		project.init();
		writeFileSync(join(folder, ".env"), "FIXTURE_SETTING=first\n");
		writeFileSync(join(web, ".env.local"), "FIXTURE_SETTING=first\n");
		project.check();
		expect(project.status().releaseReady).toBe(true);
		writeFileSync(join(folder, ".env"), "FIXTURE_SETTING=second\n");
		expect(project.status()).toMatchObject({
			checked: false,
			dirty: false,
			releaseReady: false,
		});
		project.check();
		expect(project.status().releaseReady).toBe(true);
		writeFileSync(join(web, ".env.local"), "FIXTURE_SETTING=second\n");
		expect(project.status()).toMatchObject({
			checked: false,
			dirty: false,
			releaseReady: false,
		});
	});

	test("failed final check deletes any previous success record", () => {
		const { folder, project } = fixture();
		project.init();
		project.check();
		expect(existsSync(project.stateFile)).toBe(true);
		writeFileSync(join(folder, "failure.flag"), "fail offline fixture check\n");
		expect(() => project.check()).toThrow("финальная проверка не прошла");
		expect(existsSync(project.stateFile)).toBe(false);
		expect(project.status().releaseReady).toBe(false);
	});

	test("checks that mutate source cannot produce successful validation evidence", () => {
		const { folder, project } = fixture({ checks: ["node rewrite.mjs"] });
		writeFileSync(
			join(folder, "rewrite.mjs"),
			'import { writeFileSync } from "node:fs";\nwriteFileSync("source.txt", "rewritten by checker\\n");\n'
		);
		git(folder, "add", "rewrite.mjs");
		git(folder, "commit", "-m", "Fixture mutating check");
		project.init();
		expect(() => project.check()).toThrow("проверки изменили исходники");
		expect(existsSync(project.stateFile)).toBe(false);
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"rewritten by checker\n"
		);
	});

	test("finish preserves ignored private data and removes only a clean integrated task", () => {
		const { project } = fixture();
		project.init();
		const tree = project.create("done");
		commitSource(tree, "finished task");
		project.integrate("codex/done");
		const ignored = join(tree, "ignored");
		mkdirSync(ignored);
		const privateFile = join(ignored, "local-state.txt");
		writeFileSync(privateFile, "private fixture state\n");
		expect(() => project.finish(tree)).toThrow("сохраните ignored-файлы");
		expect(readFileSync(privateFile, "utf8")).toBe("private fixture state\n");
		expect(existsSync(tree)).toBe(true);
		rmSync(privateFile);
		rmdirSync(ignored);
		project.finish(tree);
		expect(existsSync(tree)).toBe(false);
		expect(project.worktrees()).toHaveLength(1);
	});

	test("finish preserves an unmerged clean task and unrelated registered worktree", () => {
		const { base, folder, project } = fixture();
		project.init();
		const tree = project.create("unmerged");
		commitSource(tree, "unique task work");
		project.check();
		expect(() => project.finish(tree)).toThrow();
		expect(existsSync(tree)).toBe(true);
		const outside = join(base, "outside-managed-directory");
		git(folder, "worktree", "add", "-b", "codex/outside", outside, "stage");
		expect(() => project.finish(outside)).toThrow("удаление допустимо только");
		expect(existsSync(outside)).toBe(true);
	});

	test("shared lock rejects overlapping mutation and releases itself after failure", () => {
		const { project } = fixture();
		expect(() =>
			project.withLock(() => project.withLock(() => project.init()))
		).toThrow("проект занят другим stage-процессом");
		expect(existsSync(project.lockFile)).toBe(false);
		project.withLock(() => project.init());
		expect(project.branch()).toBe("stage");
		expect(existsSync(project.lockFile)).toBe(false);
	});
});
