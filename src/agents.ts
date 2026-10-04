import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Coding agents (Claude Code, Codex, Cursor) use DevHub as the only development server: their instructions name
 * the DevHub commands, a Claude Code hook refuses dev servers started around it, and the browser-pane launch
 * configuration attaches to DevHub instead of spawning a second copy of the service.
 */

export const DEV_SERVER_MARKER = "DEVHUB:DEV-SERVER";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

const slash = (path: string): string => path.replaceAll("\\", "/");

/** Instructions every agent reads: global agent files, `D:/code/AGENTS.md` and each project's AGENTS.md. */
export function devServerBlock(hubRoot: string): string {
	const hub = slash(hubRoot);
	const cli = `bun ${hub}/src/cli.ts`;
	return `<!-- BEGIN:${DEV_SERVER_MARKER} -->
## DevHub is the development server — owner policy, 2026-10-04

DevHub (\`${hub}\`, http://127.0.0.1:4700/) owns every local dev server on this computer. Agents start, inspect and stop development services only through it.

- Start: \`${cli} start <project>[/<service>]\` or the project's registered \`bun run dev\` / \`dev:*\` scripts, which delegate to DevHub. The command returns after readiness; a repeated start reuses the running process.
- Inspect: \`${cli} status [--json]\`, \`${cli} list\`, \`${cli} logs <project>/<service> [--lines N]\`. Stop or restart with \`${cli} stop|restart <project>/<service>\`.
- Browser preview: \`.claude/launch.json\` entries run \`${cli} attach <project>/<service>\`, which starts the service in DevHub and follows its log. Or start it through DevHub and open \`http://localhost:<port>/\`.
- Never run \`next dev\`, \`vite\`, \`bun --hot\`, \`node --watch\`, \`turbo dev\`, \`uvicorn --reload\`, \`expo start\`, \`wrangler dev\` and similar directly, in the background or through another process manager. Never kill a process to free a port; a port held outside DevHub needs an explicit migration.
- New or changed services are described in the project's \`devhub.json\` (command, relative cwd, port, health, env, needs, launch); restart the hub afterwards. New projects are created from the hub page («Новый проект») or \`${cli} create bts|python <name>\`, which registers them.
- Production: \`${cli} prod [<project>]\` shows the project's Coolify applications, databases and services with status, domains and commit; \`${cli} prod <project> --logs\` adds each application's last deployment and recent logs. The hub page «Прод» shows the same with deployment history. Production \`build\`, \`start\`, \`deploy\` and containers stay standalone and never depend on DevHub.
<!-- END:${DEV_SERVER_MARKER} -->`;
}

/** Replace only the marked block, preserving the rest of the instructions and front matter byte-for-byte. */
export function replaceMarkedBlock(
	before: string,
	block: string,
	marker = DEV_SERVER_MARKER
): string {
	const line = before.includes("\r\n") ? "\r\n" : "\n";
	const replacement = block.replaceAll("\n", line);
	const begin = `<!-- BEGIN:${marker} -->`;
	const end = `<!-- END:${marker} -->`;
	const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`, "g");
	const matches = [...before.matchAll(pattern)];
	if (matches.length > 1) {
		throw new Error(`несколько блоков ${marker}; проверьте инструкции вручную`);
	}
	if (matches.length === 1) {
		return before.replace(pattern, () => replacement);
	}
	if (before.includes(begin) || before.includes(end)) {
		throw new Error(`незавершённый блок ${marker}; инструкции сохранены`);
	}
	if (!before.trim()) {
		return `${replacement}${line}`;
	}
	const frontmatter = FRONTMATTER.exec(before)?.[0] ?? "";
	return `${frontmatter}${replacement}${line}${line}${before.slice(frontmatter.length)}`;
}

interface LaunchService {
	id: string;
	port?: number;
}

/** Browser-pane configurations that attach to DevHub: one per service with a port. */
export function claudeLaunchConfig(
	hubRoot: string,
	project: { id: string; services: LaunchService[] }
): {
	configurations: {
		name: string;
		port: number;
		runtimeArgs: string[];
		runtimeExecutable: string;
	}[];
	version: string;
} {
	return {
		configurations: project.services.flatMap((service) =>
			service.port
				? [
						{
							name: service.id,
							port: service.port,
							runtimeArgs: [
								`${slash(hubRoot)}/src/cli.ts`,
								"attach",
								`${project.id}/${service.id}`,
							],
							runtimeExecutable: "bun",
						},
					]
				: []
		),
		version: "0.0.1",
	};
}

/** Commands that start a development server around DevHub. Builds, tests and registered scripts pass. */
const DIRECT_DEV: { pattern: RegExp; what: string }[] = [
	{ pattern: /\bnext\s+dev\b/, what: "next dev" },
	{
		pattern:
			/(?:^|[\s;&|(])(?:bunx\s+|npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?vite(?:\s+(?:dev|serve)\b|\s*(?:$|[;&|)])|\s+--)/m,
		what: "vite",
	},
	{
		pattern: /\b(?:bun|node)\s+(?:run\s+)?--(?:hot|watch)\b(?!\s+test\b)/,
		what: "bun/node --hot|--watch",
	},
	{ pattern: /\bnodemon\b/, what: "nodemon" },
	{ pattern: /\btsx\s+watch\b/, what: "tsx watch" },
	{ pattern: /\bturbo\s+(?:run\s+)?dev\b/, what: "turbo dev" },
	{ pattern: /\buvicorn\b[^\n;&|]*--reload\b/, what: "uvicorn --reload" },
	{ pattern: /\b(?:fastapi\s+dev|flask\s+run)\b/, what: "fastapi/flask" },
	{ pattern: /\bwrangler\s+dev\b/, what: "wrangler dev" },
	{ pattern: /\bexpo\s+start\b/, what: "expo start" },
	{
		pattern: /\b(?:astro|nuxt|nuxi|remix|react-router)\s+dev\b/,
		what: "framework dev server",
	},
	{ pattern: /\bmanage\.py\s+runserver\b/, what: "manage.py runserver" },
];
/** DevHub's own entrypoints: the CLI, the copied launcher, the stage tool. */
const RUN_DEV = /\brun\s+dev(?::[\w-]+)?\b/;
const THROUGH_DEVHUB = /devhub[\\/]src[\\/]|\.devhub[\\/]launch\.cjs/;

/** The development server a shell command would start outside DevHub, if any. */
export function directDevServer(command: string): string | null {
	if (THROUGH_DEVHUB.test(command)) {
		return null;
	}
	return DIRECT_DEV.find(({ pattern }) => pattern.test(command))?.what ?? null;
}

/** The DevHub project folder that contains `cwd`: the nearest folder with `devhub.json`. */
export function devhubProject(cwd: string): string | null {
	let folder = resolve(cwd);
	for (;;) {
		if (existsSync(join(folder, "devhub.json"))) {
			return folder;
		}
		const parent = dirname(folder);
		if (parent === folder) {
			return null;
		}
		folder = parent;
	}
}

interface LaunchConfiguration {
	name?: string;
	runtimeArgs?: unknown;
	runtimeExecutable?: unknown;
	url?: unknown;
}

/** Whether a `.claude/launch.json` configuration starts nothing itself or goes through DevHub. */
export function attachesToDevhub(configuration: LaunchConfiguration): boolean {
	if (!configuration.runtimeExecutable) {
		return true;
	}
	const words = [
		String(configuration.runtimeExecutable),
		...(Array.isArray(configuration.runtimeArgs)
			? configuration.runtimeArgs.map(String)
			: []),
	].join(" ");
	return THROUGH_DEVHUB.test(words) || RUN_DEV.test(words);
}

/** The project id in its devhub.json, or a placeholder when it cannot be read. */
function projectId(folder: string): string {
	try {
		const manifest = JSON.parse(
			readFileSync(join(folder, "devhub.json"), "utf8")
		) as { id?: unknown };
		return typeof manifest.id === "string" ? manifest.id : "<project>";
	} catch {
		return "<project>";
	}
}

export interface HookInput {
	cwd?: string;
	tool_input?: Record<string, unknown>;
	tool_name?: string;
}

/** Why a tool call must not run, or null. Fails open: anything unexpected lets the call through. */
export function guardReason(input: HookInput, hubRoot: string): string | null {
	const cwd = input.cwd ?? process.cwd();
	const project = devhubProject(cwd);
	if (!project) {
		return null;
	}
	const cli = `bun ${slash(hubRoot)}/src/cli.ts`;
	const id = projectId(project);
	const tool = input.tool_name ?? "";
	if (tool === "Bash" || tool === "PowerShell") {
		const command = input.tool_input?.command;
		const what = typeof command === "string" ? directDevServer(command) : null;
		return what
			? `DevHub owns dev servers here (${slash(project)}): ${what} must not be started directly. Use \`${cli} start ${id}[/<service>]\` or the registered \`bun run dev\` script, \`${cli} status\` and \`${cli} logs ${id}/<service>\` for state and output, and describe new services in devhub.json.`
			: null;
	}
	if (tool.endsWith("preview_start")) {
		const name = input.tool_input?.name;
		if (typeof name !== "string") {
			return null;
		}
		const file = join(cwd, ".claude", "launch.json");
		if (!existsSync(file)) {
			return null;
		}
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			configurations?: LaunchConfiguration[];
		};
		const configuration = parsed.configurations?.find(
			(entry) => entry.name === name
		);
		return configuration && !attachesToDevhub(configuration)
			? `.claude/launch.json «${name}» starts a dev server outside DevHub. Start it with \`${cli} start ${id}/<service>\` and open the preview with preview_start({ url: "http://localhost:<port>" }), or replace the entry with \`${cli} attach ${id}/<service>\`.`
			: null;
	}
	return null;
}
