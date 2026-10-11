import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { devServerBlock } from "../src/agents";
import { commitOwnRewrites } from "../src/instruction-commit";
import { StageProject } from "../src/stage";
import {
	ownerParentPolicyBlock,
	ownerProjectPolicyBlock,
} from "../src/workflow-instructions";

const fixtures: string[] = [];
const FILES = ["AGENTS.md", ".cursor/rules/devhub-staging.mdc"];
const MESSAGE = "Point agent instructions at the machine-wide DevHub rules";

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

/** A project whose committed instructions still carry full copies of the rules. */
function project(): string {
	const base = mkdtempSync(join(tmpdir(), "devhub-rules-test-"));
	fixtures.push(base);
	const root = join(base, "demo");
	mkdirSync(join(root, ".devhub"), { recursive: true });
	mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
	git(root, "init", "--initial-branch=main");
	git(root, "config", "user.name", "DevHub fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "config", "commit.gpgsign", "false");
	git(root, "config", "core.autocrlf", "false");
	writeFileSync(
		join(root, ".devhub", "worktree.json"),
		`${JSON.stringify({
			checks: ["node --version"],
			mode: "mvp",
			releaseBranch: "main",
			remote: null,
			stageBranch: "stage",
			version: 1,
			worktreeRoot: "../worktrees/demo",
		})}\n`
	);
	const copies = `${devServerBlock("C:/code/devhub")}\n\n${ownerParentPolicyBlock()}`;
	writeFileSync(
		join(root, "AGENTS.md"),
		`${copies}\n\n## Demo\n\nRun \`C:/code/demo/tool.exe\`.\n`
	);
	writeFileSync(
		join(root, ".cursor", "rules", "devhub-staging.mdc"),
		`---\nalwaysApply: true\n---\n${ownerParentPolicyBlock()}\n`
	);
	writeFileSync(join(root, "source.txt"), "initial\n");
	git(root, "add", ".");
	git(root, "commit", "-m", "Initial fixture");
	return root;
}

/** What `agents --write --projects` leaves in the working files. */
function rewrite(root: string): void {
	const pointer = ownerProjectPolicyBlock(root);
	writeFileSync(
		join(root, "AGENTS.md"),
		`${pointer}\n\n## Demo\n\nRun \`F:/code/demo/tool.exe\`.\n`
	);
	writeFileSync(
		join(root, ".cursor", "rules", "devhub-staging.mdc"),
		`---\nalwaysApply: true\n---\n${pointer}\n`
	);
}

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-rules-test-")
		) {
			throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

test("DevHub commits its own rewrite and nothing else of the working folder", () => {
	const root = project();
	expect(commitOwnRewrites(root, FILES, MESSAGE)).toBeNull();
	rewrite(root);
	writeFileSync(join(root, "source.txt"), "someone's draft\n");
	writeFileSync(join(root, "staged.txt"), "someone's staged file\n");
	git(root, "add", "staged.txt");

	expect(commitOwnRewrites(root, FILES, MESSAGE)).toBe(
		"закоммичено: AGENTS.md, .cursor/rules/devhub-staging.mdc"
	);
	expect(git(root, "log", "-1", "--format=%s")).toBe(MESSAGE);
	expect(
		git(root, "show", "--name-only", "--format=", "HEAD").split("\n")
	).toEqual([".cursor/rules/devhub-staging.mdc", "AGENTS.md"]);
	// The draft and the staged file stay exactly where their author left them.
	expect(git(root, "status", "--porcelain")).toBe(
		" M source.txt\nA  staged.txt"
	);
	expect(readFileSync(join(root, "source.txt"), "utf8")).toBe(
		"someone's draft\n"
	);
	expect(commitOwnRewrites(root, FILES, MESSAGE)).toBeNull();
}, 30_000);

test("a file with someone's edits, a busy project and a merge are left alone", () => {
	const root = project();
	const head = git(root, "rev-parse", "HEAD");
	rewrite(root);
	const release = new StageProject(root).acquireLock();
	try {
		expect(commitOwnRewrites(root, FILES, MESSAGE)).toContain(
			"проект занят другим stage-процессом"
		);
	} finally {
		release();
	}
	expect(git(root, "rev-parse", "HEAD")).toBe(head);
	expect(git(root, "diff", "--cached", "--name-only")).toBe("");

	const agents = join(root, "AGENTS.md");
	writeFileSync(
		agents,
		readFileSync(agents, "utf8").replace("Run", "Never run")
	);
	expect(commitOwnRewrites(root, FILES, MESSAGE)).toBe(
		"закоммичено: .cursor/rules/devhub-staging.mdc; не закоммичено: в AGENTS.md есть чужие правки"
	);
	expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe(
		".cursor/rules/devhub-staging.mdc"
	);
	expect(git(root, "status", "--porcelain")).toBe(" M AGENTS.md");

	const merging = project();
	git(merging, "switch", "-c", "codex/task");
	writeFileSync(join(merging, "source.txt"), "task\n");
	git(merging, "commit", "-am", "Task change");
	git(merging, "switch", "main");
	writeFileSync(join(merging, "source.txt"), "main\n");
	git(merging, "commit", "-am", "Main change");
	spawnSync("git", ["-C", merging, "merge", "codex/task"], {
		windowsHide: true,
	});
	rewrite(merging);
	expect(commitOwnRewrites(merging, FILES, MESSAGE)).toBe(
		"не закоммичено: в основной папке идёт merge"
	);
}, 30_000);
