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

import { installProjectWorkflow } from "../scripts/migrate-projects";
import { applyMvpMode, main, planMvpMode } from "../scripts/project-modes";
import {
	ownerParentPolicyBlock,
	ownerProjectPolicyBlock,
	replaceOwnerPolicyBlock,
} from "../src/workflow-instructions";

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

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "devhub-project-mode-"));
	fixtures.push(base);
	const root = join(base, "project");
	const worktreeBase = join(base, "worktrees");
	mkdirSync(join(root, ".devhub"), { recursive: true });
	git(root, "init", "--initial-branch=main");
	git(root, "config", "user.name", "DevHub fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "config", "commit.gpgsign", "false");
	git(root, "config", "core.autocrlf", "false");
	mkdirSync(join(base, "hooks"));
	git(root, "config", "core.hooksPath", join(base, "hooks"));
	const policyFile = join(root, ".devhub", "worktree.json");
	const policy = {
		checks: ["node check.mjs"],
		deploy: "node existing-production.mjs",
		releaseBranch: "main",
		remote: "project-origin",
		stageBranch: "stage",
		version: 1,
		worktreeRoot: "../legacy-worktrees",
	};
	writeFileSync(policyFile, JSON.stringify(policy));
	writeFileSync(join(root, "source.txt"), "initial\n");
	writeFileSync(join(root, ".gitignore"), "private.env\n");
	const agents =
		"---\r\nalwaysApply: true\r\n---\r\n# Project instructions\r\n\r\nKeep specific security rules.\r\n";
	writeFileSync(join(root, "AGENTS.md"), agents);
	git(root, "add", ".");
	git(root, "commit", "-m", "Initial fixture");
	git(root, "switch", "-c", "stage");
	writeFileSync(join(root, "source.txt"), "unfinished work\n");
	writeFileSync(join(root, "draft.txt"), "untracked draft\n");
	writeFileSync(join(root, "private.env"), "private fixture value\n");
	return { agents, base, policy, policyFile, root, worktreeBase };
}

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-project-mode-")
		) {
			throw new Error(`Refuse cleanup outside test fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

test("mode migration dry-run is read-only and apply preserves WIP, private files and unrelated policy fields", () => {
	const f = fixture();
	const original = readFileSync(f.policyFile, "utf8");
	const plan = planMvpMode("project", f.root, f.worktreeBase);
	expect(plan.status).toBe("ready");
	expect(plan.blockers).toEqual([]);
	expect(git(f.root, "branch", "--show-current")).toBe("stage");
	expect(readFileSync(f.policyFile, "utf8")).toBe(original);
	expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe(f.agents);
	expect(applyMvpMode(plan).status).toBe("applied");
	expect(git(f.root, "branch", "--show-current")).toBe("main");
	expect(JSON.parse(readFileSync(f.policyFile, "utf8"))).toEqual({
		...f.policy,
		mode: "mvp",
		worktreeRoot: join(f.worktreeBase, "project").replaceAll("\\", "/"),
	});
	expect(readFileSync(join(f.root, "source.txt"), "utf8")).toBe(
		"unfinished work\n"
	);
	expect(readFileSync(join(f.root, "draft.txt"), "utf8")).toBe(
		"untracked draft\n"
	);
	expect(readFileSync(join(f.root, "private.env"), "utf8")).toBe(
		"private fixture value\n"
	);
	const instructions = readFileSync(join(f.root, "AGENTS.md"), "utf8");
	expect(instructions.startsWith("---\r\nalwaysApply: true\r\n---\r\n")).toBe(
		true
	);
	expect(
		instructions.endsWith(
			"# Project instructions\r\n\r\nKeep specific security rules.\r\n"
		)
	).toBe(true);
	expect(planMvpMode("project", f.root, f.worktreeBase).status).toBe(
		"unchanged"
	);
});

test("a main worktree blocks migration without changing policy or instructions", () => {
	const f = fixture();
	const linked = join(f.base, "linked-main");
	git(f.root, "worktree", "add", linked, "main");
	const before = readFileSync(f.policyFile, "utf8");
	const plan = planMvpMode("project", f.root, f.worktreeBase);
	expect(plan.status).toBe("blocked");
	expect(plan.blockers.join(" ")).toContain("main используется в worktree");
	expect(applyMvpMode(plan).status).toBe("blocked");
	expect(readFileSync(f.policyFile, "utf8")).toBe(before);
	expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe(f.agents);
	expect(git(f.root, "branch", "--show-current")).toBe("stage");
});

test("MVP migration creates main from the existing HEAD and preserves a legacy master ref", () => {
	const f = fixture();
	git(f.root, "branch", "-m", "main", "master");
	const originalHead = git(f.root, "rev-parse", "HEAD");
	const masterHead = git(f.root, "rev-parse", "master");
	writeFileSync(
		f.policyFile,
		JSON.stringify({ ...f.policy, releaseBranch: "master" })
	);
	const plan = planMvpMode("project", f.root, f.worktreeBase);
	expect(plan.blockers).toEqual([]);
	expect(applyMvpMode(plan).status).toBe("applied");
	expect(git(f.root, "rev-parse", "main")).toBe(originalHead);
	expect(git(f.root, "rev-parse", "master")).toBe(masterHead);
	expect(git(f.root, "branch", "--show-current")).toBe("main");
	expect(JSON.parse(readFileSync(f.policyFile, "utf8")).releaseBranch).toBe(
		"main"
	);
});

test("diverged main and a changed reviewed plan are rejected without overwriting work", () => {
	const f = fixture();
	const stale = planMvpMode("project", f.root, f.worktreeBase);
	writeFileSync(
		join(f.root, "AGENTS.md"),
		`${f.agents}Concurrent instructions\r\n`
	);
	expect(() => applyMvpMode(stale)).toThrow("изменились после плана");
	expect(git(f.root, "branch", "--show-current")).toBe("stage");
	git(f.root, "add", "source.txt");
	git(f.root, "commit", "-m", "Stage source");
	git(f.root, "switch", "main");
	writeFileSync(join(f.root, "source.txt"), "independent main change\n");
	git(f.root, "add", "source.txt");
	git(f.root, "commit", "-m", "Main source");
	git(f.root, "switch", "stage");
	const plan = planMvpMode("project", f.root, f.worktreeBase);
	expect(plan.status).toBe("blocked");
	expect(plan.blockers.join(" ")).toContain("main содержит другую историю");
});

test("new workflow bootstrap defaults to MVP with explicit pending checks; existing policy bytes stay intact", () => {
	const f = fixture();
	const existing = readFileSync(f.policyFile, "utf8");
	expect(installProjectWorkflow(f.root)).toEqual({
		checksConfigured: true,
		mode: "prod",
	});
	expect(readFileSync(f.policyFile, "utf8")).toBe(existing);
	const fresh = join(f.base, "new-project");
	mkdirSync(fresh);
	expect(installProjectWorkflow(fresh)).toEqual({
		checksConfigured: false,
		mode: "mvp",
	});
	expect(
		JSON.parse(readFileSync(join(fresh, ".devhub", "worktree.json"), "utf8"))
	).toMatchObject({
		checks: [],
		mode: "mvp",
		releaseBranch: "main",
		worktreeRoot: "D:/worktrees/new-project",
	});
	const agents = readFileSync(join(fresh, "AGENTS.md"), "utf8");
	installProjectWorkflow(fresh);
	expect(readFileSync(join(fresh, "AGENTS.md"), "utf8")).toBe(agents);
});

test("owner marker replacement preserves surrounding instructions and never invents parent filesystem writes", () => {
	const block = ownerProjectPolicyBlock("D:/code/project");
	const before = `Specific intro\n${block}\nSpecific footer\n`;
	const after = replaceOwnerPolicyBlock(
		before,
		ownerProjectPolicyBlock("D:/code/renamed")
	);
	expect(after.startsWith("Specific intro\n")).toBe(true);
	expect(after.endsWith("\nSpecific footer\n")).toBe(true);
	expect(after).toContain("D:/code/renamed/.devhub/worktree.json");
	expect(() => replaceOwnerPolicyBlock(`${block}\n${block}`, block)).toThrow(
		"несколько owner policy"
	);
	expect(() =>
		replaceOwnerPolicyBlock("<!-- BEGIN:DEVHUB:WORKTREE-POLICY -->", block)
	).toThrow("незавершённый");
	expect(ownerParentPolicyBlock()).toContain("D:/worktrees");
	expect(ownerParentPolicyBlock()).toContain("MVP");
	expect(ownerParentPolicyBlock()).toContain("Prod");
});

test("the compatibility CLI rejects unknown legacy arguments and refuses a parent AGENTS target before applying", async () => {
	await expect(main(["--write"])).rejects.toThrow(
		"неизвестный параметр --write"
	);
	await expect(main(["legacy-inventory.json"])).rejects.toThrow(
		"неизвестный параметр legacy-inventory.json"
	);
	await expect(
		main(["--apply", "--parent-proposal", "D:/code/AGENTS.md"])
	).rejects.toThrow("отдельным файлом");
});
