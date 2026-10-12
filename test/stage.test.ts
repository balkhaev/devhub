import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { StageProject } from "../src/stage";
import { withProjectModeText } from "../src/workflow-policy";

const fixtures: string[] = [];
const NOT_ALPHANUMERIC = /[^a-zA-Z0-9]/g;

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

function fixture(
	options: {
		committed?: boolean;
		checks?: string[];
		deploy?: string;
		mode?: "mvp" | "prod";
		remote?: string | null;
	} = {}
) {
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
			...(options.deploy ? { deploy: options.deploy } : {}),
			...(options.mode ? { mode: options.mode } : {}),
			...(options.remote === undefined ? {} : { remote: options.remote }),
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
	test("mode changes preserve existing JSON arrays and repository formatting", () => {
		const text =
			'{\r\n  "checks": ["bun run check", "bun run test"],\r\n  "releaseBranch": "main",\r\n  "stageBranch": "stage",\r\n  "version": 1,\r\n  "worktreeRoot": "F:/worktrees/project",\r\n  "mode": "mvp"\r\n}\r\n';
		expect(withProjectModeText(text, "prod")).toBe(
			text.replace('"mode": "mvp"', '"mode": "prod"')
		);
		expect(withProjectModeText(text, "mvp")).toBe(text);
	}, 30_000);
	test("explicit local MVP integrates into main and cleans its completed worktree without a remote", () => {
		const { folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		const worktree = project.create("local-task");
		const commit = commitSource(worktree, "local MVP change");
		project.integrate(worktree);
		expect(project.branch()).toBe("main");
		expect(git(folder, "merge-base", "--is-ancestor", commit, "main")).toBe("");
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"local MVP change\n"
		);
		expect(existsSync(worktree)).toBe(false);
		expect(project.status().checked).toBe(true);
	}, 30_000);

	test("MVP integrates checked commits into main and immediately pushes its configured remote", () => {
		const { base, folder, project } = fixture({ mode: "mvp" });
		const remote = join(base, "origin.git");
		mkdirSync(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(folder, "remote", "add", "origin", remote);
		git(folder, "push", "origin", "main");
		project.init();
		expect(project.branch()).toBe("main");
		const tree = project.create("mvp-change");
		commitSource(tree, "published MVP change");
		project.integrate(tree);
		expect(git(remote, "rev-parse", "main")).toBe(project.head() ?? "");
		expect(git(remote, "show", "main:source.txt")).toBe("published MVP change");
		expect(project.status()).toMatchObject({
			integrationBranch: "main",
			mode: "mvp",
			releaseReady: true,
		});
	}, 30_000);

	test("MVP deploy runs standalone without inherited DevHub ownership", () => {
		const { base, folder, project } = fixture({
			deploy: "node deploy.mjs",
			mode: "mvp",
		});
		const markers = [
			"DEVHUB_ROOT",
			"DEVHUB_PROJECT",
			"DEVHUB_SERVICE",
			"DEVHUB_FRAME_ORIGIN",
			"DEVHUB_STAGE",
			"DEVHUB_CLIENT_TOKEN",
			"DEVHUB_FUTURE_INTEGRATION",
			"DevHub_Mixed_Case",
		];
		const applicationKey = "MY_DEVHUB_APP_SETTING";
		writeFileSync(
			join(folder, "deploy.mjs"),
			`import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("ignored", { recursive: true });\nwriteFileSync("ignored/deploy-env.json", JSON.stringify({ NODE_ENV: process.env.NODE_ENV, application: process.env[${JSON.stringify(applicationKey)}], markers: ${JSON.stringify(markers)}.map(key => process.env[key] ?? null), remainingDevHub: Object.keys(process.env).filter(key => key.toUpperCase().startsWith("DEVHUB_")) }));\n`
		);
		git(folder, "add", "deploy.mjs");
		git(folder, "commit", "-m", "Fixture standalone deploy");
		const remote = join(base, "origin.git");
		mkdirSync(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(folder, "remote", "add", "origin", remote);
		const inherited = [...markers, "NODE_ENV", applicationKey];
		const previous = inherited.map((key) => process.env[key]);
		try {
			for (const key of inherited) {
				process.env[key] = "development-owner-fixture";
			}
			project.publish();
		} finally {
			for (const [index, key] of inherited.entries()) {
				const value = previous[index];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
		expect(git(remote, "rev-parse", "main")).toBe(project.head() ?? "");
		expect(
			JSON.parse(readFileSync(join(folder, "ignored/deploy-env.json"), "utf8"))
		).toEqual({
			application: "development-owner-fixture",
			markers: markers.map(() => null),
			NODE_ENV: "production",
			remainingDevHub: [],
		});
	}, 30_000);

	test("failed MVP checks do not publish a changed main", () => {
		const { base, folder, project } = fixture({ mode: "mvp" });
		const remote = join(base, "origin.git");
		mkdirSync(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(folder, "remote", "add", "origin", remote);
		git(folder, "push", "origin", "main");
		const before = git(remote, "rev-parse", "main");
		const tree = project.create("bad-mvp");
		commitSource(tree, "not yet safe to publish");
		writeFileSync(join(folder, "failure.flag"), "fail check\n");
		expect(() => project.integrate(tree)).toThrow(
			"финальная проверка не прошла"
		);
		expect(git(remote, "rev-parse", "main")).toBe(before);
		expect(project.status().checked).toBe(false);
	}, 30_000);

	test("MVP publishes its own checked tree while preserving unrelated canonical drafts", () => {
		const { base, folder, project } = fixture({ mode: "mvp" });
		writeFileSync(join(folder, "other.txt"), "original\n");
		git(folder, "add", "other.txt");
		git(folder, "commit", "-m", "Independent file");
		const remote = join(base, "origin.git");
		mkdirSync(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(folder, "remote", "add", "origin", remote);
		git(folder, "push", "origin", "main");
		writeFileSync(join(folder, "other.txt"), "someone else's draft\n");
		writeFileSync(join(folder, "draft.txt"), "untracked draft\n");
		const tree = project.create("mvp-scoped");
		commitSource(tree, "own completed change");
		project.integrate(tree);
		expect(git(remote, "show", "main:source.txt")).toBe("own completed change");
		expect(git(remote, "show", "main:other.txt")).toBe("original");
		expect(readFileSync(join(folder, "other.txt"), "utf8")).toBe(
			"someone else's draft\n"
		);
		expect(readFileSync(join(folder, "draft.txt"), "utf8")).toBe(
			"untracked draft\n"
		);
		expect(existsSync(tree)).toBe(false);
		expect(project.worktrees()).toHaveLength(1);
	}, 30_000);

	test("mode transition fast-forwards main without losing staged, unstaged or private work", () => {
		const { folder, project } = fixture();
		project.init();
		const head = commitSource(folder, "validated stage change");
		writeFileSync(join(folder, "source.txt"), "staged draft\n");
		git(folder, "add", "source.txt");
		writeFileSync(join(folder, "source.txt"), "unstaged draft\n");
		writeFileSync(join(folder, "draft.txt"), "untracked\n");
		mkdirSync(join(folder, "ignored"));
		writeFileSync(join(folder, "ignored", "private.txt"), "private\n");
		project.setMode("mvp");
		expect(project.branch()).toBe("main");
		expect(git(folder, "rev-parse", "HEAD^")).toBe(head);
		expect(
			git(folder, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
		).toBe(".devhub/worktree.json");
		expect(git(folder, "show", ":source.txt")).toBe("staged draft");
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"unstaged draft\n"
		);
		expect(readFileSync(join(folder, "draft.txt"), "utf8")).toBe("untracked\n");
		expect(readFileSync(join(folder, "ignored", "private.txt"), "utf8")).toBe(
			"private\n"
		);
	}, 30_000);

	test("mode transition refuses divergent main and leaves both histories intact", () => {
		const { folder, project } = fixture();
		git(folder, "branch", "stage");
		const mainHead = commitSource(folder, "main branch history");
		git(folder, "switch", "stage");
		const stageHead = commitSource(folder, "divergent stage history");
		expect(() => project.setMode("mvp")).toThrow("другую историю");
		expect(project.branch()).toBe("stage");
		expect(project.head()).toBe(stageHead);
		expect(git(folder, "rev-parse", "main")).toBe(mainHead);
		expect(project.policy.mode).toBe("prod");
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

	test("dirty canonical checkout blocks creating and integrating worktrees", () => {
		const { folder, project } = fixture();
		project.init();
		writeFileSync(join(folder, "source.txt"), "unsaved canonical work\n");
		expect(() => project.create("task")).toThrow("есть локальные изменения");
		expect(() => project.integrate("main")).toThrow("есть локальные изменения");
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"unsaved canonical work\n"
		);
	}, 30_000);

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
	}, 30_000);

	test("source and index changes invalidate a successful final-check record", () => {
		const { folder, project } = fixture();
		project.init();
		project.check();
		expect(project.status().releaseReady).toBe(true);
		writeFileSync(join(folder, "source.txt"), "changed after check\n");
		expect(project.status().checked).toBe(false);
		git(folder, "add", "source.txt");
		expect(project.status().checked).toBe(false);
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

	test("failed final check deletes any previous success record", () => {
		const { folder, project } = fixture();
		project.init();
		project.check();
		expect(existsSync(project.stateFile)).toBe(true);
		writeFileSync(join(folder, "failure.flag"), "fail offline fixture check\n");
		expect(() => project.check()).toThrow("финальная проверка не прошла");
		expect(existsSync(project.stateFile)).toBe(false);
		expect(project.status().releaseReady).toBe(false);
	}, 30_000);

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
	}, 30_000);

	test("finish closes a clean integrated task and deletes its merged branch without archives", () => {
		const { project } = fixture();
		project.init();
		const tree = project.create("done");
		const head = commitSource(tree, "finished task");
		project.integrate("codex/done");
		expect(project.finish(tree)).toBe(tree);
		expect(git(project.root, "for-each-ref", "refs/heads/codex")).toBe("");
		expect(
			git(project.root, "merge-base", "--is-ancestor", head, "stage")
		).toBe("");
		expect(git(project.root, "for-each-ref", "refs/archive")).toBe("");
		expect(existsSync(tree)).toBe(false);
		expect(project.worktrees()).toHaveLength(1);
	}, 30_000);

	test("finish removes rebuildable ignored folders with the checkout", () => {
		const { folder, project } = fixture();
		writeFileSync(
			join(folder, ".gitignore"),
			"ignored/\nfailure.flag\nnode_modules/\n.pytest_cache/\n*.tsbuildinfo\n"
		);
		git(folder, "add", ".gitignore");
		git(folder, "commit", "-m", "Ignore dependencies");
		project.init();
		const tree = project.create("installed");
		commitSource(tree, "finished task");
		project.integrate("codex/installed");
		mkdirSync(join(tree, "packages", "web", "node_modules", "left-pad"), {
			recursive: true,
		});
		writeFileSync(
			join(tree, "packages", "web", "node_modules", "left-pad", "index.js"),
			"module.exports = 1;\n"
		);
		mkdirSync(join(tree, ".pytest_cache"));
		writeFileSync(join(tree, ".pytest_cache", "lastfailed"), "{}\n");
		writeFileSync(join(tree, "tsconfig.tsbuildinfo"), "{}\n");
		expect(project.finish(tree)).toBe(tree);
		expect(existsSync(tree)).toBe(false);
	}, 30_000);

	test("finish keeps private ignored data in the working checkout", () => {
		const { project } = fixture();
		project.init();
		const tree = project.create("private");
		commitSource(tree, "finished task");
		project.integrate("codex/private");
		mkdirSync(join(tree, "ignored"));
		const privateFile = join(tree, "ignored", "local-state.txt");
		writeFileSync(privateFile, "private fixture state\n");
		expect(() => project.finish(tree)).toThrow("приватные ignored-файлы");
		expect(readFileSync(privateFile, "utf8")).toBe("private fixture state\n");
		expect(project.worktrees()).toHaveLength(2);
	}, 30_000);

	test("finish removes an ignored copy of a file the canonical folder still holds", () => {
		const { folder, project } = fixture();
		project.init();
		const tree = project.create("copied");
		commitSource(tree, "finished task");
		project.integrate("codex/copied");
		const settings = join("ignored", "settings.local.json");
		for (const checkout of [folder, tree]) {
			mkdirSync(join(checkout, "ignored"));
			writeFileSync(join(checkout, settings), '{"allow":[]}\n');
		}
		// A copy the task changed is its own state again.
		writeFileSync(join(tree, settings), '{"allow":["task"]}\n');
		expect(() => project.finish(tree)).toThrow("приватные ignored-файлы");
		expect(existsSync(join(tree, settings))).toBe(true);
		writeFileSync(join(tree, settings), '{"allow":[]}\n');
		expect(project.finish(tree)).toBe(tree);
		expect(existsSync(tree)).toBe(false);
		expect(readFileSync(join(folder, settings), "utf8")).toBe('{"allow":[]}\n');
	}, 30_000);

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
	}, 30_000);

	test("close retains an unmerged branch without integrating or publishing it", () => {
		const { folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		const main = git(folder, "rev-parse", "HEAD");
		const tree = project.create("closed");
		const task = commitSource(tree, "committed task");
		project.close(tree);
		expect(git(folder, "rev-parse", "codex/closed")).toBe(task);
		expect(git(folder, "rev-parse", "main")).toBe(main);
		expect(git(folder, "for-each-ref", "refs/archive")).toBe("");
		expect(existsSync(tree)).toBe(false);
		expect(project.worktrees()).toHaveLength(1);
	}, 30_000);

	test("close refuses unsaved files, locks and detached HEADs", () => {
		const { folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		const tree = project.create("working");
		writeFileSync(join(tree, "draft.txt"), "unsaved work\n");
		expect(() => project.close(tree)).toThrow();
		expect(readFileSync(join(tree, "draft.txt"), "utf8")).toBe(
			"unsaved work\n"
		);
		git(tree, "add", "draft.txt");
		git(tree, "commit", "-m", "Preserve task work");
		git(folder, "worktree", "lock", tree);
		expect(() => project.close(tree)).toThrow();
		expect(existsSync(tree)).toBe(true);
		git(folder, "worktree", "unlock", tree);
		git(tree, "switch", "--detach");
		expect(() => project.close(tree)).toThrow("сохраните HEAD в ветке");
		expect(existsSync(tree)).toBe(true);
	}, 30_000);

	test("close rejects canonical checkout and worktrees outside the policy", () => {
		const { base, folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		const outside = join(base, "outside-managed-directory");
		git(folder, "worktree", "add", "-b", "codex/outside", outside, "main");
		expect(() => project.close(folder)).toThrow("закрытие допустимо только");
		expect(() => project.close(outside)).toThrow("закрытие допустимо только");
		expect(existsSync(folder)).toBe(true);
		expect(existsSync(outside)).toBe(true);
	}, 30_000);

	test.skipIf(process.platform !== "win32")(
		"closing ends a process that still works in the checkout",
		async () => {
			const { project } = fixture({ mode: "mvp", remote: null });
			const tree = project.create("held");
			commitSource(tree, "finished task");
			const child = spawn(
				process.execPath,
				["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
				{ cwd: tree, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
			);
			const exited = () => child.exitCode !== null || child.signalCode !== null;
			try {
				// A new process opens its folder a moment after it is created.
				if (child.stdout) {
					await once(child.stdout, "data");
				}
				project.integrate(tree);
				expect(existsSync(tree)).toBe(false);
				expect(project.worktrees()).toHaveLength(1);
				expect(git(project.root, "for-each-ref", "refs/heads/codex")).toBe("");
				if (!exited()) {
					await Promise.race([once(child, "exit"), delay(5000)]);
				}
				expect(exited()).toBe(true);
			} finally {
				child.kill();
			}
		},
		60_000
	);

	test.skipIf(process.platform !== "win32")(
		"the session that closes its own checkout is not ended: the task closes and tidy takes the emptied folder",
		() => {
			const { project } = fixture({ mode: "mvp", remote: null });
			const tree = project.create("own");
			commitSource(tree, "finished task");
			const home = process.cwd();
			process.chdir(tree);
			try {
				project.integrate(tree);
				// Closed all the same: no registration and no branch.
				expect(project.worktrees()).toHaveLength(1);
				expect(git(project.root, "for-each-ref", "refs/heads/codex")).toBe("");
				expect(readdirSync(tree)).toEqual([]);
				const report = project.tidy();
				expect(report.unregistered).toEqual([]);
				expect(report.emptied.map((item) => item.path)).toEqual([tree]);
				expect(
					report.emptied[0]?.holders.map((holder) => holder.pid)
				).toContain(process.pid);
				// Not even an explicit kill ends the session that asks for it.
				expect(project.tidyApply({ kill: true })).toMatchObject({
					ended: [],
					folders: [],
				});
				expect(existsSync(tree)).toBe(true);
			} finally {
				process.chdir(home);
			}
			expect(project.tidyApply().folders).toEqual([tree]);
			expect(existsSync(tree)).toBe(false);
		},
		60_000
	);

	test("tidy removes leftover folders that hold no files and keeps those that do", () => {
		const { project } = fixture({ mode: "mvp", remote: null });
		const emptied = join(project.worktreeRoot, "closed");
		mkdirSync(join(emptied, "apps", "web"), { recursive: true });
		mkdirSync(join(emptied, "node_modules", "left-pad"), { recursive: true });
		writeFileSync(
			join(emptied, "node_modules", "left-pad", "index.js"),
			"module.exports = 1;\n"
		);
		const notes = join(project.worktreeRoot, "notes");
		mkdirSync(join(notes, "deep"), { recursive: true });
		writeFileSync(join(notes, "deep", "draft.txt"), "someone's work\n");
		project.processes = {
			end: () => {
				throw new Error("nothing is ended without kill");
			},
			survey: () => ({
				fileUsers: [],
				processes: [
					{
						cwd: emptied,
						exe: null,
						name: "claude.exe",
						parent: 1,
						pid: 4242,
						started: 1,
					},
				],
			}),
		};

		const report = project.tidy();
		expect(report.emptied).toMatchObject([
			{ holders: [{ name: "claude.exe", pid: 4242 }], path: emptied },
		]);
		// Used a moment ago: the folder was just made.
		expect(Date.now() - (report.emptied[0]?.used ?? 0)).toBeLessThan(60_000);
		expect(report.unregistered).toEqual([notes]);

		expect(project.tidyApply()).toMatchObject({
			ended: [],
			folders: [emptied],
		});
		expect(existsSync(emptied)).toBe(false);
		expect(readFileSync(join(notes, "deep", "draft.txt"), "utf8")).toBe(
			"someone's work\n"
		);
		const after = project.tidy();
		expect(after.emptied).toEqual([]);
		expect(after.unregistered).toEqual([notes]);
	}, 30_000);

	test("a leftover folder nobody used for a day goes by itself; any use within the day keeps it", () => {
		const { base, project } = fixture({ mode: "mvp", remote: null });
		const DAY = 24 * 60 * 60 * 1000;
		const HOUR = 60 * 60 * 1000;
		const longAgo = new Date(Date.now() - 2 * DAY);
		const hourAgo = new Date(Date.now() - HOUR);
		const leftover = (name: string): string => {
			const folder = join(project.worktreeRoot, name);
			mkdirSync(folder, { recursive: true });
			utimesSync(folder, longAgo, longAgo);
			return folder;
		};
		const forgotten = leftover("forgotten");
		const logged = leftover("logged");
		const started = leftover("started");
		const today = join(project.worktreeRoot, "today");
		mkdirSync(today);
		// A session opened in `logged` wrote to its log an hour ago.
		project.sessionLogs = join(base, "logs");
		const log = join(
			project.sessionLogs,
			logged.replace(NOT_ALPHANUMERIC, "-"),
			"session.jsonl"
		);
		mkdirSync(dirname(log), { recursive: true });
		writeFileSync(log, "{}\n");
		utimesSync(log, hourAgo, hourAgo);
		// A process began to work in `started` an hour ago; the one in `forgotten` has sat there for two days.
		const ended: number[] = [];
		project.processes = {
			end: (pid) => ended.push(pid),
			survey: () => ({
				fileUsers: [],
				processes: [
					{
						cwd: started,
						exe: null,
						name: "bash.exe",
						parent: 1,
						pid: 7001,
						started: hourAgo.getTime(),
					},
					{
						cwd: forgotten,
						exe: null,
						name: "claude.exe",
						parent: 1,
						pid: 7002,
						started: longAgo.getTime(),
					},
				],
			}),
		};

		const report = project.tidy();
		expect(
			Object.fromEntries(
				report.emptied.map((item) => [
					basename(item.path),
					Math.round((Date.now() - item.used) / HOUR),
				])
			)
		).toEqual({ forgotten: 48, logged: 1, started: 1, today: 0 });

		expect(project.removeIdleFolders().folders).toEqual([forgotten]);
		expect(existsSync(forgotten)).toBe(false);
		for (const folder of [logged, started, today]) {
			expect(existsSync(folder)).toBe(true);
		}
		// Nothing held these folders for real, so nobody had to be ended.
		expect(ended).toEqual([]);
		// A day later the rest is forgotten too.
		project.now = () => Date.now() + DAY;
		expect(project.removeIdleFolders().folders.sort()).toEqual(
			[logged, started, today].sort()
		);
	}, 30_000);

	test.skipIf(process.platform !== "win32")(
		"the processes that hold a folder nobody used for a day are ended; within the day they are left alone",
		async () => {
			const { base, project } = fixture({ mode: "mvp", remote: null });
			project.sessionLogs = join(base, "logs");
			const swept = join(project.worktreeRoot, "swept");
			const applied = join(project.worktreeRoot, "applied");
			const later = () => Date.now() + 25 * 60 * 60 * 1000;
			const children: ReturnType<typeof spawn>[] = [];
			const exited = (child: ReturnType<typeof spawn>) =>
				child.exitCode !== null || child.signalCode !== null;
			const idleIn = async (folder: string) => {
				mkdirSync(folder, { recursive: true });
				const child = spawn(
					process.execPath,
					["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
					{
						cwd: folder,
						stdio: ["ignore", "pipe", "ignore"],
						windowsHide: true,
					}
				);
				children.push(child);
				// A new process opens its folder a moment after it is created.
				if (child.stdout) {
					await once(child.stdout, "data");
				}
				return child;
			};
			try {
				const first = await idleIn(swept);
				expect(project.removeIdleFolders()).toEqual({ ended: [], folders: [] });
				expect(exited(first)).toBe(false);
				project.now = later;
				const sweptAway = project.removeIdleFolders();
				expect(sweptAway.folders).toEqual([swept]);
				expect(sweptAway.ended.map((holder) => holder.pid)).toEqual([
					first.pid as number,
				]);

				// The explicit cleanup follows the same rule without --kill.
				project.now = Date.now;
				const second = await idleIn(applied);
				expect(project.tidyApply()).toMatchObject({ ended: [], folders: [] });
				expect(exited(second)).toBe(false);
				project.now = later;
				const cleaned = project.tidyApply();
				expect(cleaned.folders).toEqual([applied]);
				expect(cleaned.ended.map((holder) => holder.pid)).toEqual([
					second.pid as number,
				]);
				expect(existsSync(swept) || existsSync(applied)).toBe(false);
			} finally {
				for (const child of children) {
					child.kill();
				}
			}
		},
		90_000
	);

	test("tidy reports what tasks left behind and removes only what holds nothing", () => {
		const { base, folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		// Closed and merged: a branch left by an earlier finish.
		git(folder, "branch", "codex/merged");
		// Closed with its own commit: parked work.
		const parked = project.create("parked");
		const parkedHead = commitSource(parked, "parked work");
		project.close(parked);
		// A registration whose folder was deleted by hand.
		const gone = project.create("gone");
		const goneHead = commitSource(gone, "lost folder");
		rmSync(gone, { force: true, recursive: true });
		// A working task and a checkout outside the policy folder.
		const working = project.create("working");
		writeFileSync(join(working, "draft.txt"), "unsaved work\n");
		const outside = join(base, "elsewhere");
		git(folder, "worktree", "add", "-b", "claude/session", outside, "main");
		writeFileSync(join(folder, "canonical-draft.txt"), "owner draft\n");

		const report = project.tidy();
		expect(report.canonicalChanges).toBe(1);
		expect(report.merged.map((item) => item.branch)).toEqual(["codex/merged"]);
		expect(report.missing).toHaveLength(1);
		expect(report.parked).toEqual([
			{ ahead: 1, branch: "codex/parked", days: 0 },
		]);
		expect(
			report.working.map((item) => [
				item.branch,
				item.ahead,
				item.changes,
				item.outside,
			])
		).toEqual([
			["codex/working", 0, 1, false],
			["claude/session", 0, 0, true],
		]);

		const applied = project.tidyApply();
		expect(applied.branches).toEqual(["codex/merged"]);
		expect(applied.pruned).toHaveLength(1);
		// Own commits survive pruning: the branch becomes parked work.
		expect(git(folder, "rev-parse", "codex/gone")).toBe(goneHead);
		expect(git(folder, "rev-parse", "codex/parked")).toBe(parkedHead);
		expect(git(folder, "for-each-ref", "refs/heads/codex/merged")).toBe("");
		const after = project.tidy();
		expect(after.merged).toEqual([]);
		expect(after.missing).toEqual([]);
		expect(after.parked.map((item) => item.branch)).toEqual([
			"codex/gone",
			"codex/parked",
		]);
		expect(after.working).toHaveLength(2);
		expect(readFileSync(join(working, "draft.txt"), "utf8")).toBe(
			"unsaved work\n"
		);
	}, 30_000);

	test("shared lock rejects overlapping mutation and releases itself after failure", () => {
		const { project } = fixture();
		expect(() =>
			project.withLock(() => project.withLock(() => project.init()))
		).toThrow("проект занят другим stage-процессом");
		expect(existsSync(project.lockFile)).toBe(false);
		project.withLock(() => project.init());
		expect(project.branch()).toBe("stage");
		expect(existsSync(project.lockFile)).toBe(false);
	}, 30_000);

	test("a lock left by a killed stage process is recovered, a live one is kept", async () => {
		const { project } = fixture();
		const finished = spawnSync(process.execPath, ["-e", "0"]);
		writeFileSync(project.lockFile, `${finished.pid}\n`);
		const running = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 60000)"],
			{ stdio: "ignore", windowsHide: true }
		);
		try {
			project.withLock(() => project.init());
			expect(project.branch()).toBe("stage");
			expect(existsSync(project.lockFile)).toBe(false);
			// The holder started before it took the lock, as every real holder does.
			await delay(500);
			const live = `${running.pid}\n`;
			writeFileSync(project.lockFile, live);
			expect(() => project.withLock(() => project.init())).toThrow(
				`проект занят другим stage-процессом: ${project.lockFile} (PID ${running.pid})`
			);
			expect(readFileSync(project.lockFile, "utf8")).toBe(live);
		} finally {
			running.kill();
			rmSync(project.lockFile, { force: true });
		}
	}, 30_000);
});

describe("recovery after an interrupted create", () => {
	const adminOf = (folder: string) =>
		resolve(
			folder,
			readFileSync(join(folder, ".git"), "utf8").replace("gitdir:", "").trim()
		);

	test("a checkout whose Git registration is gone is rebuilt with an empty branch", () => {
		const { folder, project } = fixture({ mode: "mvp" });
		const task = project.create("interrupted");
		const stale = git(folder, "rev-parse", "codex/interrupted");
		rmSync(adminOf(task), { force: true, recursive: true });
		rmSync(join(task, "check.mjs"));
		commitSource(folder, "moved on");
		expect(() =>
			git(
				folder,
				"worktree",
				"add",
				"-b",
				"codex/interrupted",
				`${task}-x`,
				"main"
			)
		).toThrow("already exists");
		expect(project.create("interrupted")).toBe(task);
		expect(git(task, "rev-parse", "HEAD")).toBe(
			git(folder, "rev-parse", "main")
		);
		expect(git(task, "rev-parse", "HEAD")).not.toBe(stale);
		expect(git(task, "status", "--porcelain")).toBe("");
		expect(project.worktrees().map((item) => item.branch)).toContain(
			"codex/interrupted"
		);
	}, 30_000);

	test("a registration still locked as initializing is not reused as a ready worktree", () => {
		const { project } = fixture({ mode: "mvp" });
		const task = project.create("initializing");
		writeFileSync(join(adminOf(task), "locked"), "initializing");
		rmSync(join(task, "source.txt"));
		expect(
			project.worktrees().find((item) => item.branch === "codex/initializing")
				?.locked
		).toBe("initializing");
		expect(project.create("initializing")).toBe(task);
		expect(readFileSync(join(task, "source.txt"), "utf8")).toBe("initial\n");
		expect(
			project.worktrees().find((item) => item.branch === "codex/initializing")
				?.locked
		).toBeUndefined();
	}, 30_000);

	test("a leftover branch without a checkout is replaced only when it has no own commits", () => {
		const { folder, project } = fixture({ mode: "mvp" });
		git(folder, "branch", "codex/branch-only", "main");
		expect(project.create("branch-only")).toBe(
			resolve(project.worktreeRoot, "branch-only")
		);
		git(folder, "switch", "-c", "codex/with-work");
		const work = commitSource(folder, "work");
		git(folder, "switch", "main");
		expect(() => project.create("with-work")).toThrow(
			"ветка codex/with-work содержит коммиты вне main (1)"
		);
		expect(git(folder, "rev-parse", "codex/with-work")).toBe(work);
		expect(existsSync(resolve(project.worktreeRoot, "with-work"))).toBe(false);
	}, 30_000);

	test("an orphaned checkout with edits, extra files or commits is reported and kept", () => {
		const { folder, project } = fixture({ mode: "mvp" });
		const edited = project.create("edited");
		writeFileSync(join(edited, "notes.txt"), "keep me\n");
		writeFileSync(join(edited, "source.txt"), "changed\n");
		rmSync(adminOf(edited), { force: true, recursive: true });
		expect(() => project.create("edited")).toThrow(
			"прерванный create остаётся рабочим"
		);
		expect(readFileSync(join(edited, "notes.txt"), "utf8")).toBe("keep me\n");
		expect(git(folder, "rev-parse", "--verify", "codex/edited")).toBeTruthy();

		const committed = project.create("committed");
		const work = commitSource(committed, "work");
		rmSync(adminOf(committed), { force: true, recursive: true });
		expect(() => project.create("committed")).toThrow(
			"ветка codex/committed содержит коммиты вне main"
		);
		expect(existsSync(join(committed, "source.txt"))).toBe(true);
		expect(git(folder, "rev-parse", "codex/committed")).toBe(work);

		const foreign = resolve(project.worktreeRoot, "foreign");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, "data.txt"), "not a checkout\n");
		expect(() => project.create("foreign")).toThrow(
			`путь worktree недоступен: ${foreign}`
		);
		expect(existsSync(join(foreign, "data.txt"))).toBe(true);
	}, 30_000);
});
