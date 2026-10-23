import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	attachesToDevhub,
	claudeLaunchConfig,
	DEV_SERVER_MARKER,
	devServerBlock,
	markedBlock,
	removeMarkedBlock,
	replaceMarkedBlock,
} from "../src/agents";
import { primaryCheckout } from "../src/checkouts";
import { loadCatalogue } from "../src/config";
import { commitOwnRewrites } from "../src/instruction-commit";
import {
	PROJECT_KNOWLEDGE_MARKER,
	projectKnowledgeBlock,
} from "../src/knowledge-instructions";
import {
	ownerParentPolicyBlock,
	ownerProjectPolicyBlock,
	WORKFLOW_POLICY_MARKER,
} from "../src/workflow-instructions";

/**
 * Keeps the owner's rules for coding agents in one place. Dry-run by default; `--write` applies:
 * - the full rules (dev servers, project modes and worktrees, rules projects share with the whole machine) in the
 *   machine-wide files: the AGENTS.md above the projects and above their worktrees, `~/.claude/CLAUDE.md` and
 *   `~/.codex/AGENTS.md`;
 * - the Claude Code PreToolUse guard in `~/.claude/settings.json`;
 * - with `--projects`, a short pointer to those rules in every project's AGENTS.md and Cursor rule instead of a
 *   copy of them, committed at once when the file holds no one else's edits, and a `.claude/launch.json` that
 *   attaches to DevHub (an existing configuration that spawns servers itself is kept in
 *   `.devhub/original-claude-launch.json`).
 * Other content of these files is preserved byte-for-byte.
 */

const hub = primaryCheckout(resolve(import.meta.dirname, ".."));
const GUARD = "agent-guard.ts";
const MATCHER = "Bash|PowerShell|mcp__.*preview_start";
const HOOK_TIMEOUT_S = 10;
const CURSOR_RULE = join(".cursor", "rules", "devhub-staging.mdc");
/** Rules a project keeps for every agent of the machine: its AGENTS.md holds the text, the machine-wide files mirror it. */
const SHARED: Record<string, string> = { "INFERENCE:QUEUE-PAUSE": "inference" };
const COMMIT_MESSAGE =
	"Point agent instructions at the machine-wide DevHub rules";

interface Change {
	file: string;
	note: string;
	write: () => void;
}

const serialize = (value: unknown): string =>
	`${JSON.stringify(value, null, 2)}\n`;
const slash = (path: string): string => path.replaceAll("\\", "/");
const read = (file: string): string =>
	existsSync(file) ? readFileSync(file, "utf8") : "";

function rewrite(file: string, after: string, note: string): Change | null {
	const before = read(file);
	return after === before
		? null
		: {
				file,
				note: before ? note : "новые инструкции",
				write: () => {
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(file, after);
				},
			};
}

/** The full rules: every agent of the machine reads one of these files whatever folder it works in. */
function machineInstructions(
	file: string,
	shared: Map<string, string>
): Change | null {
	let after = replaceMarkedBlock(read(file), devServerBlock(hub));
	after = replaceMarkedBlock(
		after,
		projectKnowledgeBlock(hub),
		PROJECT_KNOWLEDGE_MARKER
	);
	after = replaceMarkedBlock(
		after,
		ownerParentPolicyBlock(),
		WORKFLOW_POLICY_MARKER
	);
	for (const [marker, block] of shared) {
		after = replaceMarkedBlock(after, block, marker);
	}
	return rewrite(file, after, "правила владельца для всей машины");
}

/** A repository keeps a pointer, not a copy: a rule change then edits no checkout. */
function projectInstructions(root: string): (Change | null)[] {
	const pointer = (file: string, always: boolean): Change | null => {
		const before = read(file);
		if (!(before || always)) {
			return null;
		}
		return rewrite(
			file,
			replaceMarkedBlock(
				removeMarkedBlock(before, DEV_SERVER_MARKER),
				ownerProjectPolicyBlock(root),
				WORKFLOW_POLICY_MARKER
			),
			"ссылка на общие правила вместо их копии"
		);
	};
	return [
		pointer(join(root, "AGENTS.md"), true),
		pointer(join(root, CURSOR_RULE), false),
	];
}

const commitInstructions = (root: string): string | null =>
	commitOwnRewrites(root, ["AGENTS.md", slash(CURSOR_RULE)], COMMIT_MESSAGE);

interface HookEntry {
	hooks?: { command?: string; timeout?: number; type?: string }[];
	matcher?: string;
}

/** The guard hook in Claude Code's user settings, replacing an older copy of itself. */
function claudeHook(file: string): Change | null {
	const settings = existsSync(file)
		? (JSON.parse(readFileSync(file, "utf8")) as {
				hooks?: Record<string, HookEntry[] | undefined>;
			})
		: {};
	const command = `bun "${slash(join(hub, "src", GUARD))}"`;
	const wanted: HookEntry = {
		hooks: [{ command, timeout: HOOK_TIMEOUT_S, type: "command" }],
		matcher: MATCHER,
	};
	settings.hooks ??= {};
	const entries = settings.hooks.PreToolUse ?? [];
	const others = entries.filter(
		(entry) => !entry.hooks?.some((hook) => hook.command?.includes(GUARD))
	);
	const next = [...others, wanted];
	if (JSON.stringify(next) === JSON.stringify(entries)) {
		return null;
	}
	settings.hooks.PreToolUse = next;
	return {
		file,
		note: "PreToolUse: dev-серверы только через DevHub",
		write: () => {
			const backup = `${file}.before-devhub`;
			if (existsSync(file) && !existsSync(backup)) {
				writeFileSync(backup, readFileSync(file));
			}
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, serialize(settings));
		},
	};
}

/** The browser-pane configuration of a project: attach to DevHub instead of spawning a second server. */
function launchConfig(
	root: string,
	project: { id: string; services: { id: string; port?: number }[] }
): Change | null {
	const file = join(root, ".claude", "launch.json");
	const wanted = claudeLaunchConfig(hub, project);
	if (wanted.configurations.length === 0) {
		return null;
	}
	const before = existsSync(file) ? readFileSync(file, "utf8") : null;
	if (before === serialize(wanted)) {
		return null;
	}
	const current = before
		? (JSON.parse(before) as { configurations?: { name?: string }[] })
		: null;
	const spawns = (current?.configurations ?? []).filter(
		(configuration) => !attachesToDevhub(configuration)
	);
	// A project's own configuration that already goes through DevHub is not rewritten for its wording.
	if (current?.configurations?.length && spawns.length === 0) {
		return null;
	}
	return {
		file,
		note: spawns.length
			? `заменяет самостоятельный запуск: ${spawns.map((entry) => entry.name).join(", ")}`
			: "превью через DevHub",
		write: () => {
			const original = join(root, ".devhub", "original-claude-launch.json");
			if (before && spawns.length && !existsSync(original)) {
				mkdirSync(dirname(original), { recursive: true });
				writeFileSync(original, before);
			}
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, serialize(wanted));
		},
	};
}

/** The folders that hold projects' worktrees: an AGENTS.md there is read from every one of them. */
function worktreeParents(roots: string[]): string[] {
	const parents = new Set<string>();
	for (const root of roots) {
		try {
			const policy = JSON.parse(
				readFileSync(join(root, ".devhub", "worktree.json"), "utf8")
			) as { worktreeRoot?: unknown };
			if (typeof policy.worktreeRoot === "string") {
				parents.add(dirname(resolve(root, policy.worktreeRoot)));
			}
		} catch {
			// A project without a readable policy has no worktree folder to cover.
		}
	}
	return [...parents];
}

interface Listed {
	project: { id: string; services: { id: string; port?: number }[] };
	root: string;
}

/** The text of every rule a project shares with the machine, read from that project's AGENTS.md. */
function sharedBlocks(listed: Listed[]): Map<string, string> {
	const shared = new Map<string, string>();
	for (const [marker, id] of Object.entries(SHARED)) {
		const owner = listed.find((entry) => entry.project.id === id);
		const block = owner
			? markedBlock(read(join(owner.root, "AGENTS.md")), marker)
			: null;
		if (block) {
			shared.set(marker, block);
		}
	}
	return shared;
}

function machineChanges(
	code: string,
	roots: string[],
	shared: Map<string, string>
): (Change | null)[] {
	const files = new Set([
		join(code, "AGENTS.md"),
		...worktreeParents(roots).map((folder) => join(folder, "AGENTS.md")),
		join(homedir(), ".claude", "CLAUDE.md"),
		join(homedir(), ".codex", "AGENTS.md"),
	]);
	return [
		...[...files].map((file) => machineInstructions(file, shared)),
		claudeHook(join(homedir(), ".claude", "settings.json")),
	];
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const projects = args.includes("--projects");
	const catalogue = await loadCatalogue(join(hub, "services.json"));
	const listed: Listed[] = catalogue.projects.map((project) => ({
		project,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: machine catalogue placeholder
		root: resolve(project.path.replaceAll("${code}", catalogue.code)),
	}));
	// The hub is a project too, though its own catalogue does not list it.
	const roots = [
		...new Set([...listed.map((entry) => entry.root), hub]),
	].filter((root) => existsSync(root));
	const changes = machineChanges(
		resolve(catalogue.code),
		roots,
		sharedBlocks(listed)
	);
	for (const root of projects ? roots : []) {
		const project = listed.find((entry) => entry.root === root)?.project;
		changes.push(
			...projectInstructions(root),
			project ? launchConfig(root, project) : null
		);
	}
	const planned = changes.filter((change): change is Change => change !== null);
	const say = (line: string) => process.stdout.write(`${line}\n`);
	for (const change of planned) {
		if (write) {
			change.write();
		}
		say(
			`${write ? "записано" : "план"}: ${slash(change.file)} — ${change.note}`
		);
	}
	// Also a rewrite an earlier run could not commit: its project was busy then.
	const committed = (write && projects ? roots : [])
		.map((root) => ({ outcome: commitInstructions(root), root }))
		.filter((entry) => entry.outcome);
	for (const { outcome, root } of committed) {
		say(`${slash(root)} — ${outcome}`);
	}
	const hint = `${write ? "" : "; примените с --write"}${projects ? "" : " (файлы проектов: --projects)"}`;
	say(
		planned.length === 0
			? "Инструкции агентов актуальны."
			: `${planned.length} изменений${hint}`
	);
}

if (import.meta.main) {
	await main();
}
