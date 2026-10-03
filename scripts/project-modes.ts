import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
	isInsideProject,
	primaryCheckout,
	sameSourcePath,
} from "../src/checkouts";
import { type Catalogue, loadCatalogue } from "../src/config";
import { gitOutput, StageProject } from "../src/stage";
import {
	ownerParentPolicyBlock,
	ownerProjectPolicyBlock,
	replaceOwnerPolicyBlock,
} from "../src/workflow-instructions";
import { workflowPolicySchema } from "../src/workflow-policy";

const WORKTREE_ENTRIES = /\r?\n\r?\n/;
const WORKTREE_PATH = /^worktree (.+)$/m;
const MAIN_WORKTREE = /^branch refs\/heads\/main$/m;

export interface ProjectModePlan {
	blockers: string[];
	branch: string;
	changes: string[];
	fingerprint: string;
	head: string | null;
	id: string;
	root: string;
	status: "ready" | "unchanged" | "blocked" | "applied" | "failed";
	warnings: string[];
	worktreeRoot: string;
}

function readOptional(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function fingerprint(
	policy: string,
	agents: string,
	branch: string,
	head: string | null
): string {
	return createHash("sha256")
		.update(JSON.stringify([policy, agents, branch, head]))
		.digest("hex");
}

/** Read-only planning: no StageProject constructor, state folders, branch changes or working-file writes. */
export function planMvpMode(
	id: string,
	folder: string,
	worktreeBase = "D:/worktrees"
): ProjectModePlan {
	const root = primaryCheckout(folder);
	const policyFile = join(root, ".devhub", "worktree.json");
	const agentsFile = join(root, "AGENTS.md");
	const before = readOptional(policyFile);
	const agents = readOptional(agentsFile);
	const branch = gitOutput(root, ["symbolic-ref", "--short", "HEAD"], true);
	const head = gitOutput(root, ["rev-parse", "--verify", "HEAD"], true) || null;
	const plan: ProjectModePlan = {
		blockers: [],
		branch,
		changes: [],
		fingerprint: fingerprint(before, agents, branch, head),
		head,
		id,
		root,
		status: "ready",
		warnings: [],
		worktreeRoot: resolve(worktreeBase, basename(root)).replaceAll("\\", "/"),
	};
	try {
		const policy = workflowPolicySchema.parse(JSON.parse(before));
		if (
			policy.mode !== "mvp" ||
			policy.releaseBranch !== "main" ||
			!sameSourcePath(resolve(root, policy.worktreeRoot), plan.worktreeRoot)
		) {
			plan.changes.push(policyFile);
		}
		if (
			replaceOwnerPolicyBlock(agents, ownerProjectPolicyBlock(root)) !== agents
		) {
			plan.changes.push(agentsFile);
		}
		if (branch !== "main") {
			plan.changes.push("Git canonical branch → main");
		}
		if (policy.checks.length === 0) {
			plan.warnings.push(
				"checks пуст: финальная проверка и публикация останутся заблокированы до настройки"
			);
		}
		if (isInsideProject(root, plan.worktreeRoot)) {
			plan.blockers.push("worktreeRoot должен находиться вне основной папки");
		}
		const mainHead = gitOutput(
			root,
			["rev-parse", "--verify", "refs/heads/main"],
			true
		);
		if (head && mainHead && head !== mainHead) {
			const ancestor = spawnSync(
				"git",
				["-C", root, "merge-base", "--is-ancestor", mainHead, head],
				{ windowsHide: true }
			);
			if (ancestor.status !== 0) {
				plan.blockers.push(
					"main содержит другую историю; автоматический перенос запрещён"
				);
			}
		}
		const worktrees = gitOutput(root, [
			"worktree",
			"list",
			"--porcelain",
		]).split(WORKTREE_ENTRIES);
		for (const entry of worktrees) {
			const path = WORKTREE_PATH.exec(entry)?.[1];
			if (path && MAIN_WORKTREE.test(entry) && !sameSourcePath(path, root)) {
				plan.blockers.push(`main используется в worktree ${path}`);
			}
		}
		if (gitOutput(root, ["rev-parse", "--verify", "MERGE_HEAD"], true)) {
			plan.blockers.push("сначала завершите текущий merge");
		}
	} catch (error) {
		plan.blockers.push((error as Error).message);
	}
	if (plan.blockers.length > 0) {
		plan.status = "blocked";
	} else if (plan.changes.length === 0) {
		plan.status = "unchanged";
	}
	return plan;
}

function writeAtomic(file: string, text: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, file);
}

/** Apply only the reviewed policy and owner marker. Git transitions use the shared guarded mode operation. */
export function applyMvpMode(reviewed: ProjectModePlan): ProjectModePlan {
	if (reviewed.blockers.length > 0) {
		return reviewed;
	}
	const project = new StageProject(reviewed.root);
	return project.withLock(() => {
		const current = planMvpMode(
			reviewed.id,
			reviewed.root,
			resolve(reviewed.worktreeRoot, "..")
		);
		if (current.fingerprint !== reviewed.fingerprint) {
			throw new Error(
				"политика, инструкции или HEAD изменились после плана; повторите проверку"
			);
		}
		if (current.blockers.length > 0 || current.status === "unchanged") {
			return current;
		}
		const policyFile = join(current.root, ".devhub", "worktree.json");
		const agentsFile = join(current.root, "AGENTS.md");
		const before = readFileSync(policyFile, "utf8");
		const original = JSON.parse(before) as Record<string, unknown>;
		const agents = readOptional(agentsFile);
		const instructions = replaceOwnerPolicyBlock(
			agents,
			ownerProjectPolicyBlock(current.root)
		);
		// Normalize main/location before the guarded transition; keep the original mode until setMode succeeds.
		const prepared = {
			...original,
			releaseBranch: "main",
			worktreeRoot: current.worktreeRoot,
		};
		try {
			writeAtomic(policyFile, `${JSON.stringify(prepared, null, 2)}\n`);
			const transition = new StageProject(current.root);
			transition.setMode("mvp", { commit: false });
			writeAtomic(
				policyFile,
				`${JSON.stringify({ ...prepared, mode: "mvp" }, null, 2)}\n`
			);
		} catch (error) {
			if (
				gitOutput(current.root, ["symbolic-ref", "--short", "HEAD"], true) ===
					current.branch &&
				(gitOutput(current.root, ["rev-parse", "--verify", "HEAD"], true) ||
					null) === current.head
			) {
				writeAtomic(policyFile, before);
			}
			throw error;
		}
		if (agents !== instructions) {
			writeAtomic(agentsFile, instructions);
		}
		return { ...current, branch: "main", status: "applied" };
	});
}

export function catalogueModePlans(
	catalogue: Catalogue,
	hubRoot: string,
	worktreeBase = "D:/worktrees"
): ProjectModePlan[] {
	const projects = [
		...catalogue.projects.map((project) => ({
			id: project.id,
			root: project.path,
		})),
		{ id: "devhub", root: hubRoot },
	];
	const unique = projects.filter(
		(project, index) =>
			projects.findIndex((other) =>
				sameSourcePath(
					primaryCheckout(other.root),
					primaryCheckout(project.root)
				)
			) === index
	);
	return unique.map((project) =>
		planMvpMode(project.id, project.root, worktreeBase)
	);
}

function parseArgs(args: string[]) {
	let apply = false;
	let worktreeBase = "D:/worktrees";
	let parentProposal: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--apply") {
			apply = true;
		} else if (arg === "--worktree-root" || arg === "--parent-proposal") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error(`после ${arg} нужен путь`);
			}
			index += 1;
			if (arg === "--worktree-root") {
				worktreeBase = resolve(value);
			} else {
				parentProposal = resolve(value);
			}
		} else {
			throw new Error(`неизвестный параметр ${arg}`);
		}
	}
	if (
		parentProposal &&
		basename(parentProposal).toLowerCase() === "agents.md"
	) {
		throw new Error(
			"parent proposal должен быть отдельным файлом, а не AGENTS.md"
		);
	}
	return { apply, parentProposal, worktreeBase };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const hubRoot = primaryCheckout(resolve(import.meta.dir, ".."));
	const { apply, parentProposal, worktreeBase } = parseArgs(args);
	const catalogue = await loadCatalogue(join(hubRoot, "services.json"));
	if (isInsideProject(catalogue.code, worktreeBase)) {
		throw new Error("worktree root должен находиться вне D:/code");
	}
	const plans = catalogueModePlans(catalogue, hubRoot, worktreeBase);
	const results = plans.map((plan) => {
		if (!apply) {
			return plan;
		}
		try {
			return applyMvpMode(plan);
		} catch (error) {
			return {
				...plan,
				blockers: [...plan.blockers, (error as Error).message],
				status: "failed",
			};
		}
	});
	if (parentProposal) {
		writeAtomic(parentProposal, `${ownerParentPolicyBlock()}\n`);
	}
	process.stdout.write(
		`${JSON.stringify({ apply, parentProposal, projects: results }, null, 2)}\n`
	);
	if (apply && results.some((plan) => plan.blockers.length > 0)) {
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`devhub project modes: ${(error as Error).message}\n`);
		process.exitCode = 1;
	});
}
