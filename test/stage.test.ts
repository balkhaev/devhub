import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { StageProject } from "../src/stage";
import { withProjectModeText } from "../src/workflow-policy";

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
			'{\r\n  "checks": ["bun run check", "bun run test"],\r\n  "releaseBranch": "main",\r\n  "stageBranch": "stage",\r\n  "version": 1,\r\n  "worktreeRoot": "D:/worktrees/project",\r\n  "mode": "mvp"\r\n}\r\n';
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
		const archive = project.finish(tree);
		expect(
			readFileSync(join(archive, "files", "ignored", "local-state.txt"), "utf8")
		).toBe("private fixture state\n");
		expect(existsSync(tree)).toBe(false);
		expect(project.worktrees()).toHaveLength(1);
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

	test("archive preserves an unfinished task without integrating or publishing it", () => {
		const { folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		const main = git(folder, "rev-parse", "HEAD");
		const tree = project.create("blocked");
		const task = commitSource(tree, "unique unfinished commit");
		writeFileSync(join(tree, "source.txt"), "staged task edit\n");
		git(tree, "add", "source.txt");
		writeFileSync(join(tree, "source.txt"), "unstaged task edit\n");
		writeFileSync(join(tree, "draft.txt"), "untracked task work\n");
		mkdirSync(join(tree, "ignored"));
		writeFileSync(join(tree, "ignored", "private.txt"), "private task state\n");
		writeFileSync(join(folder, "source.txt"), "foreign canonical work\n");
		git(folder, "add", "source.txt");
		writeFileSync(join(folder, "failure.flag"), "checks cannot pass\n");
		const canonicalIndex = git(folder, "diff", "--cached", "--binary");
		const archive = project.archive(tree);
		const metadata = JSON.parse(
			readFileSync(join(archive, "archive.json"), "utf8")
		) as { archiveRef: string; head: string; state: string };
		expect(metadata.state).toBe("archived");
		expect(metadata.head).toBe(task);
		expect(git(folder, "rev-parse", metadata.archiveRef)).toBe(task);
		expect(git(folder, "rev-parse", "main")).toBe(main);
		expect(git(folder, "diff", "--cached", "--binary")).toBe(canonicalIndex);
		expect(readFileSync(join(folder, "source.txt"), "utf8")).toBe(
			"foreign canonical work\n"
		);
		expect(readFileSync(join(archive, "files", "source.txt"), "utf8")).toBe(
			"unstaged task edit\n"
		);
		expect(readFileSync(join(archive, "files", "draft.txt"), "utf8")).toBe(
			"untracked task work\n"
		);
		expect(
			readFileSync(join(archive, "files", "ignored", "private.txt"), "utf8")
		).toBe("private task state\n");
		expect(readFileSync(join(archive, "staged.patch"), "utf8")).toContain(
			"+staged task edit"
		);
		expect(readFileSync(join(archive, "unstaged.patch"), "utf8")).toContain(
			"+unstaged task edit"
		);
		expect(existsSync(join(archive, "index.bin"))).toBe(true);
		expect(existsSync(tree)).toBe(false);
		expect(project.worktrees()).toHaveLength(1);
	}, 30_000);

	test("archive rejects the canonical checkout and worktrees outside its policy", () => {
		const { base, folder, project } = fixture({ mode: "mvp", remote: null });
		project.init();
		const outside = join(base, "outside-managed-directory");
		git(folder, "worktree", "add", "-b", "codex/outside", outside, "main");
		expect(() => project.archive(folder)).toThrow(
			"архивирование допустимо только"
		);
		expect(() => project.archive(outside)).toThrow(
			"архивирование допустимо только"
		);
		expect(existsSync(folder)).toBe(true);
		expect(existsSync(outside)).toBe(true);
		expect(project.worktrees()).toHaveLength(2);
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
});
