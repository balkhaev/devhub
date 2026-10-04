import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	attachesToDevhub,
	claudeLaunchConfig,
	devServerBlock,
	replaceMarkedBlock,
} from "../src/agents";
import { primaryCheckout } from "../src/checkouts";
import { loadCatalogue } from "../src/config";

/**
 * Makes coding agents use DevHub as their development server. Dry-run by default; `--write` applies:
 * - the DevHub block in `D:/code/AGENTS.md`, `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`;
 * - the Claude Code PreToolUse guard in `~/.claude/settings.json`;
 * - with `--projects`, the block in every project's AGENTS.md and a `.claude/launch.json` that attaches to DevHub
 *   (an existing configuration that spawns servers itself is kept in `.devhub/original-claude-launch.json`).
 * Other content of these files is preserved byte-for-byte.
 */

const hub = primaryCheckout(resolve(import.meta.dirname, ".."));
const GUARD = "agent-guard.ts";
const MATCHER = "Bash|PowerShell|mcp__.*preview_start";
const HOOK_TIMEOUT_S = 10;

interface Change {
	file: string;
	note: string;
	write: () => void;
}

const serialize = (value: unknown): string =>
	`${JSON.stringify(value, null, 2)}\n`;
const slash = (path: string): string => path.replaceAll("\\", "/");

function instructions(file: string): Change | null {
	const before = existsSync(file) ? readFileSync(file, "utf8") : "";
	const after = replaceMarkedBlock(before, devServerBlock(hub));
	return after === before
		? null
		: {
				file,
				note: before ? "блок DevHub в инструкциях" : "новые инструкции",
				write: () => {
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(file, after);
				},
			};
}

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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const projects = args.includes("--projects");
	const catalogue = await loadCatalogue(join(hub, "services.json"));
	const changes: (Change | null)[] = [
		instructions(join(resolve(catalogue.code), "AGENTS.md")),
		instructions(join(homedir(), ".claude", "CLAUDE.md")),
		instructions(join(homedir(), ".codex", "AGENTS.md")),
		claudeHook(join(homedir(), ".claude", "settings.json")),
	];
	if (projects) {
		for (const project of catalogue.projects) {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: machine catalogue placeholder
			const root = resolve(project.path.replaceAll("${code}", catalogue.code));
			if (!existsSync(root)) {
				continue;
			}
			changes.push(
				instructions(join(root, "AGENTS.md")),
				launchConfig(root, project)
			);
		}
	}
	const planned = changes.filter((change): change is Change => change !== null);
	for (const change of planned) {
		if (write) {
			change.write();
		}
		process.stdout.write(
			`${write ? "записано" : "план"}: ${slash(change.file)} — ${change.note}\n`
		);
	}
	process.stdout.write(
		planned.length === 0
			? "Агенты уже настроены на DevHub.\n"
			: `${planned.length} изменений${write ? "" : "; примените с --write"}${projects ? "" : " (файлы проектов: --projects)"}\n`
	);
}

if (import.meta.main) {
	await main();
}
