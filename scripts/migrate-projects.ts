import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
	isInsideProject,
	primaryCheckout,
	sameSourcePath,
} from "../src/checkouts";
import {
	ownerProjectPolicyBlock,
	replaceOwnerPolicyBlock,
} from "../src/workflow-instructions";
import { workflowPolicySchema } from "../src/workflow-policy";

/** Repeatable workstation migration. Dry-run is the default; --write applies it. */
interface Service {
	command?: string;
	cwd?: string;
	env?: Record<string, string>;
	health?: string;
	id: string;
	name: string;
	needs?: string[];
	port?: number;
	restart?: "always" | "never" | "on-failure";
	restartDelayMs?: number;
	ui?: { label: string; url: string }[];
	[key: string]: unknown;
}

interface Project {
	compose?: {
		file: string;
		overrides?: string[];
		project: string;
		services?: string[];
	};
	description?: string;
	id: string;
	launch?: Record<string, string[]>;
	name: string;
	path?: string;
	services: Service[];
}

interface Package {
	name?: string;
	scripts?: Record<string, string>;
	[key: string]: unknown;
}

interface Originals {
	packages: Record<string, Record<string, string>>;
	version: 1;
}

interface Entry {
	data: Package;
	file: string;
	folder: string;
	scripts: Record<string, string>;
}

interface MigrationResult {
	id: string;
	root?: string;
	scripts: number;
	services: number;
	workflow?: { mode: "mvp" | "prod"; checksConfigured: boolean };
}

interface Edit {
	data: Package;
	file: string;
}

interface Launcher {
	content: string;
	file: string;
}

const hub = resolve(import.meta.dirname, "..");
const WRAPPER = /(?:^|\s)node\s+[^\s]*\.devhub\/launch\.cjs\s/;
const ENV_PREFIX = /^([A-Z][A-Z0-9_]*)=([^\s]+)\s+/;
const PORT_FLAG = /(?:--port|-p)\s+(\d+)/;
const TURBO_FILTER = /(?:-F\s+|--filter(?:=|\s+))([^\s]+)/;
const DEV_KEY = /(^|:)dev($|:)/;
const IGNORED_ROOT =
	/^(?:\.|devhub$|modeler-backup-|rt-chrome-profile$|artifacts$)/;
const HOT_COMMAND = /--hot|--watch/;
const LOCAL_PORT = /^PORT\s*=\s*["']?(\d+)["']?\s*(?:#.*)?$/m;
const AGGREGATE_DEV = /turbo run dev|scripts\/dev\.ts/;
const FILTERED_DEV = /turbo run dev|bun run (?:--cwd|dev:)/;
const ABSOLUTE_PATH = /^(?:[A-Z]:|\/)/i;
const PRODUCTION_KEY = /^(?:build|start|deploy)(?::|$)/;
const ROOT_SERVICES: Record<string, string> = {
	altay: "site",
	"balkhaev-com": "site",
	soclogin: "api",
};
// biome-ignore lint/suspicious/noTemplateCurlyInString: catalogue files use this literal placeholder.
const CODE_TOKEN = "${code}";
const HUB_PORTS: Record<string, number> = {
	"cloak-browser": 3007,
	"companion-chat": 3013,
	"companion-payments": 3012,
	openmontage: 3002,
	personas: 3003,
	render: 3008,
};

function slash(value: string): string {
	return value.replaceAll("\\", "/");
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/** New registrations start in MVP; existing checks, mode and release configuration are preserved. */
export function installProjectWorkflow(root: string): {
	mode: "mvp" | "prod";
	checksConfigured: boolean;
} {
	const file = join(root, ".devhub", "worktree.json");
	const existing = existsSync(file);
	const proposed = existing
		? readJson(file)
		: {
				checks: [],
				mode: "mvp",
				releaseBranch: "main",
				stageBranch: "stage",
				version: 1,
				worktreeRoot: `D:/worktrees/${basename(root)}`,
			};
	const policy = workflowPolicySchema.parse(proposed);
	const agents = join(root, "AGENTS.md");
	const before = existsSync(agents) ? readFileSync(agents, "utf8") : "";
	const after = replaceOwnerPolicyBlock(before, ownerProjectPolicyBlock(root));
	if (!existing) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, serialize(proposed));
	}
	if (after !== before) {
		writeFileSync(agents, after);
	}
	return { checksConfigured: policy.checks.length > 0, mode: policy.mode };
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function directories(root: string): string[] {
	if (!existsSync(root)) {
		return [];
	}
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name));
}

function packages(root: string, originals: Originals): Entry[] {
	const folders = [root, ...directories(join(root, "apps"))];
	for (const extra of ["desktop", "tooling/hub-mcp"]) {
		if (existsSync(join(root, extra, "package.json"))) {
			folders.push(join(root, extra));
		}
	}
	const entries: Entry[] = [];
	for (const folder of folders) {
		const file = join(folder, "package.json");
		if (!existsSync(file)) {
			continue;
		}
		const data = readJson<Package>(file);
		const rel = slash(relative(root, file));
		entries.push({
			data,
			file,
			folder: slash(relative(root, folder)),
			scripts: { ...data.scripts, ...originals.packages[rel] },
		});
	}
	return entries;
}

function isDevScript(key: string, command: string): boolean {
	if (DEV_KEY.test(key)) {
		return true;
	}
	if (key === "control:serve" || key === "studio") {
		return true;
	}
	if (key === "watch" && HOT_COMMAND.test(command)) {
		return true;
	}
	if (["start", "web"].includes(key) && command.startsWith("expo start")) {
		return true;
	}
	if (key === "start" && command.startsWith("wrangler dev")) {
		return true;
	}
	return key === "worker" && command === "bun run src/worker.ts";
}

function launchKey(entry: Entry, key: string): string {
	return entry.folder ? `${entry.folder}:${key}` : key;
}

function serviceId(project: Project, entry: Entry, key: string): string {
	let base = basename(entry.folder || "app");
	if (!entry.folder) {
		if (key === "control:serve") {
			return "api";
		}
		if (key === "studio" || key === "desktop:dev") {
			return key === "studio" ? "studio" : "desktop";
		}
		base = ROOT_SERVICES[project.id] ?? "app";
	}
	if (base === "web-neon" && project.id === "luvclub") {
		base = "web";
	}
	if (key === "worker:dev" || key === "dev:worker" || key === "worker") {
		return "worker";
	}
	if (base === "studio" && project.id === "montage") {
		base = "studio-local";
	}
	if (base === "studio" && key === "watch") {
		return "studio-watch";
	}
	return ["dev", "watch"].includes(key)
		? slug(base)
		: slug(`${base}-${key.replaceAll(":", "-")}`);
}

function commandEnvironment(command: string): {
	command: string;
	env: Record<string, string>;
} {
	const env: Record<string, string> = {};
	let raw = command;
	let match = ENV_PREFIX.exec(raw);
	while (match) {
		env[match[1] as string] = match[2] as string;
		raw = raw.slice(match[0].length);
		match = ENV_PREFIX.exec(raw);
	}
	return { command: raw, env };
}

function inferredPort(
	entry: Entry,
	key: string,
	command: string
): number | undefined {
	const explicit = PORT_FLAG.exec(command)?.[1];
	if (explicit) {
		return Number(explicit);
	}
	if (command.startsWith("expo start")) {
		return 8081;
	}
	if (command.includes("vinext dev")) {
		return 5173;
	}
	if (command.startsWith("wrangler dev")) {
		return 8787;
	}
	if (entry.folder === "apps/server" && command.includes("src/index.ts")) {
		return 3000;
	}
	if (command === "bun run build && bun scripts/serve.ts") {
		return 4175;
	}
	if (key === "studio" || entry.folder === "apps/studio") {
		return 4747;
	}
	return undefined;
}

function leafService(
	project: Project,
	entry: Entry,
	key: string,
	raw: string
): string {
	const id = serviceId(project, entry, key);
	const parsed = commandEnvironment(raw);
	const existing = project.services.find((service) => service.id === id);
	if (key === "control:serve" && existing?.command) {
		return id;
	}
	const port = existing?.port ?? inferredPort(entry, key, parsed.command);
	const next: Service = {
		...existing,
		command: parsed.command,
		cwd: entry.folder || undefined,
		env: { ...existing?.env, ...parsed.env },
		id,
		name: existing?.name ?? id,
		...(port ? { port } : {}),
	};
	if (existing) {
		Object.assign(existing, next);
	} else {
		project.services.push(next);
	}
	return id;
}

function filteredFolder(project: Project, key: string, raw: string): string {
	const filter = TURBO_FILTER.exec(raw)?.[1];
	let folder = filter?.split("/").at(-1) ?? key.slice(4);
	if (["neon", "starter", "ember"].includes(folder)) {
		folder = `web-${folder}`;
	}
	if (["luvclub", "gsc"].includes(project.id) && folder === "web") {
		folder = "web-neon";
	}
	return folder;
}

function rootTargets(
	project: Project,
	entry: Entry,
	key: string,
	raw: string
): string[] | null {
	if (entry.folder) {
		return null;
	}
	const launch = project.launch ?? {};
	if (key === "dev" && AGGREGATE_DEV.test(raw)) {
		if (["luvclub", "gsc"].includes(project.id)) {
			return [
				"server",
				"worker",
				project.id === "luvclub" ? "web" : "web-neon",
				"admin",
			];
		}
		return Object.entries(launch)
			.filter(([name]) => name.startsWith("apps/") && name.endsWith(":dev"))
			.flatMap(([, ids]) => ids);
	}
	if (key.startsWith("dev:") && FILTERED_DEV.test(raw)) {
		const folder = filteredFolder(project, key, raw);
		return launch[`apps/${folder}:dev`] ?? null;
	}
	if (key === "worker" && raw === "cd apps/server && bun run worker") {
		return Object.hasOwn(launch, "apps/server:worker")
			? (launch["apps/server:worker"] as string[])
			: null;
	}
	return null;
}

function inferredCompose(root: string, id: string): Project["compose"] {
	for (const file of [
		"docker-compose.yml",
		"docker-compose.yaml",
		"compose.yml",
		"compose.yaml",
	]) {
		if (!existsSync(join(root, file))) {
			continue;
		}
		const body = readFileSync(join(root, file), "utf8");
		const services = ["postgres", "redis", "clickhouse"].filter((service) =>
			body.includes(`  ${service}:`)
		);
		if (services.length > 0) {
			return { file, project: id, services };
		}
	}
	return undefined;
}

function pythonRuntime(root: string, project: Project): void {
	if (!existsSync(join(root, "predict/local.py"))) {
		return;
	}
	const interpreter = existsSync(join(root, ".venv/Scripts/python.exe"))
		? ".venv/Scripts/python.exe"
		: "../predict/.venv/Scripts/python.exe";
	project.services.push({
		command: `${interpreter} -m predict.local up`,
		env: { PYTHONUTF8: "1" },
		health: "/api/health",
		id: "runtime",
		name: "Predict runtime",
		port: 8080,
	});
	if (project.id === "predict-paper") {
		(project.launch as Record<string, string[]>).dev = ["runtime"];
	}
}

function managedPython(project: Project): void {
	if (project.id === "inference") {
		const queue = project.services.find((service) => service.id === "queue");
		if (queue) {
			queue.command = ".venv/Scripts/python.exe -m inference.tray";
		}
	}
	if (project.id === "predict") {
		(project.launch as Record<string, string[]>).dev = ["laya"];
	}
}

function pythonServices(root: string, project: Project): void {
	pythonRuntime(root, project);
	managedPython(project);
	if (existsSync(join(root, "pyproject.toml"))) {
		const python = readFileSync(join(root, "pyproject.toml"), "utf8");
		if (
			python.includes('inference = "inference.cli:main"') &&
			!project.services.some((s) => s.id === "queue")
		) {
			project.services.push({
				command: "uv run --no-sync inference serve",
				health: "/health",
				id: "queue",
				name: "Inference queue",
				port: 8765,
			});
		}
		if (
			python.includes('mediapipes = "mediapipes.cli:app"') &&
			!project.services.some((s) => s.id === "api")
		) {
			project.services.push({
				command: "uv run --no-sync mediapipes serve",
				health: "/api/v1/health",
				id: "api",
				name: "MediaPipes API",
				port: 8088,
			});
		}
	}
	if (
		existsSync(join(root, "scripts/laya_up.ps1")) &&
		!project.services.some((s) => s.id === "laya")
	) {
		project.services.push({
			command:
				"powershell -NoProfile -ExecutionPolicy Bypass -File scripts/laya_up.ps1",
			env: { PYTHONUTF8: "1" },
			health: "/api/health",
			id: "laya",
			name: "Laya",
			port: 8080,
		});
	}
	for (const service of project.services) {
		if (service.id === "laya") {
			service.command =
				".venv-laya/Scripts/python.exe -m predict.laya_local --model artifacts/laya-live/laya-train/run1 --device cpu --port 8080";
		}
		if (service.cwd && ABSOLUTE_PATH.test(service.cwd)) {
			service.cwd = slash(relative(root, service.cwd));
		}
	}
	const launch = project.launch as Record<string, string[]>;
	for (const service of project.services) {
		if (
			service.command &&
			["queue", "api", "generation", "laya", "runtime"].includes(service.id)
		) {
			launch[`dev:${service.id}`] ??= [service.id];
		}
	}
	launch.dev ??= project.services
		.filter((service) => service.command)
		.map((service) => service.id);
}

function packageServices(
	project: Project,
	entries: Entry[],
	nested: boolean
): void {
	const launch = project.launch as Record<string, string[]>;
	for (const entry of entries.filter(
		(item) => Boolean(item.folder) === nested
	)) {
		for (const [key, raw] of Object.entries(entry.scripts)) {
			if (
				!(
					isDevScript(key, raw) ||
					(key === "worker" && raw === "cd apps/server && bun run worker")
				)
			) {
				continue;
			}
			const targets = nested ? null : rootTargets(project, entry, key, raw);
			launch[launchKey(entry, key)] = targets ?? [
				leafService(project, entry, key, raw),
			];
		}
	}
}

function buildProject(
	root: string,
	seed: Project | undefined,
	entries: Entry[]
): Project {
	const id = seed?.id ?? slug(basename(root));
	const project: Project = {
		...structuredClone(seed),
		id,
		launch: {},
		name: seed?.name ?? basename(root),
		services: structuredClone(seed?.services ?? []),
	};
	project.path = undefined;
	project.compose ??= inferredCompose(root, id);
	// Leaf commands must be available before root Turbo aliases are resolved.
	packageServices(project, entries, true);
	packageServices(project, entries, false);
	if (project.id === "montage") {
		const studio = project.services.find((service) => service.id === "studio");
		if (studio) {
			studio.command = "bun apps/cli/src/main.ts studio";
			studio.cwd = undefined;
		}
	}
	pythonServices(root, project);
	for (const service of project.services) {
		if (project.compose && service.id === "server") {
			service.needs ??= [`docker:${project.compose.project}`];
		}
	}
	return project;
}

function wrapper(entry: Entry, key: string): string {
	const launcher = slash(
		relative(
			dirname(entry.file),
			resolve(
				entry.file,
				"..",
				...entry.folder
					.split("/")
					.filter(Boolean)
					.map(() => ".."),
				".devhub/launch.cjs"
			)
		)
	);
	return `node ${launcher} ${launchKey(entry, key)}`;
}

function assertProductionUnchanged(
	before: Package,
	after: Package,
	file: string
): void {
	for (const [key, command] of Object.entries(before.scripts ?? {})) {
		if (
			PRODUCTION_KEY.test(key) &&
			!isDevScript(key, command) &&
			after.scripts?.[key] !== command
		) {
			throw new Error(`${file}: production command ${key} changed`);
		}
	}
}

function addStandaloneProduction(
	project: Project,
	entry: Entry,
	after: Package
): void {
	if (entry.folder) {
		return;
	}
	after.scripts ??= {};
	if (project.id === "legacy-vibecoder") {
		after.scripts.deploy ??=
			"wrangler deploy --config dist/server/wrangler.json";
	}
	if (project.id === "balkhaev-com") {
		after.scripts.start ??= "bun scripts/serve.ts";
	}
}

function syntheticEntrypoint(
	project: Project,
	entry: Entry,
	key: string,
	originals: Originals,
	rel: string,
	managed: string
): boolean {
	if (
		originals.packages[rel]?.[key] !== undefined ||
		entry.data.scripts?.[key] !== managed
	) {
		return false;
	}
	// New aggregate entrypoints have no retired raw package command; the contract owns all raw leaves.
	const targets = project.launch?.[launchKey(entry, key)] ?? [];
	return (
		targets.length > 0 &&
		targets.every((target) => {
			const id = target.startsWith(`${project.id}/`)
				? target.slice(project.id.length + 1)
				: target;
			const command = project.services.find(
				(service) => service.id === id
			)?.command;
			return Boolean(command && !WRAPPER.test(command));
		})
	);
}

export function packageEdits(
	root: string,
	project: Project,
	entries: Entry[],
	originals: Originals
): { count: number; edits: Edit[] } {
	let count = 0;
	const edits: Edit[] = [];
	for (const entry of entries) {
		const after = structuredClone(entry.data);
		const rel = slash(relative(root, entry.file));
		for (const key of Object.keys(entry.scripts)) {
			if (!project.launch?.[launchKey(entry, key)]) {
				continue;
			}
			const raw = entry.scripts[key] as string;
			const managed = wrapper(entry, key);
			const current = entry.data.scripts?.[key];
			if (WRAPPER.test(raw)) {
				if (syntheticEntrypoint(project, entry, key, originals, rel, managed)) {
					count += 1;
					continue;
				}
				throw new Error(
					`${entry.file}: original ${key} is a wrapper; cannot recover raw command`
				);
			}
			if (current !== raw && current !== managed) {
				throw new Error(
					`${entry.file}: ${key} changed since migration; update devhub.json explicitly`
				);
			}
			originals.packages[rel] ??= {};
			(originals.packages[rel] as Record<string, string>)[key] ??= raw;
			after.scripts ??= {};
			after.scripts[key] = managed;
			count += 1;
		}
		assertProductionUnchanged(entry.data, after, entry.file);
		addStandaloneProduction(project, entry, after);
		if (JSON.stringify(entry.data) !== JSON.stringify(after)) {
			edits.push({ data: after, file: entry.file });
		}
	}
	return { count, edits };
}

function localLaunchers(root: string, project: Project): Launcher[] {
	const launch = project.launch as Record<string, string[]>;
	const launchers: Launcher[] = [];
	const add = (
		file: string,
		script: string,
		parameters = "",
		open?: string
	): void => {
		if (!existsSync(join(root, file))) {
			return;
		}
		const location = slash(relative(dirname(file), ".devhub/launch.cjs"));
		const content = `${parameters}$ErrorActionPreference = 'Stop'\n& node (Join-Path $PSScriptRoot '${location}') '${script}'\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n${open ? `if ($Open) { Start-Process '${open}' }\n` : ""}exit 0\n`;
		launchers.push({ content, file });
	};
	if (Object.hasOwn(launch, "dev:queue")) {
		add(
			"scripts/start.ps1",
			"dev:queue",
			"param([switch]$Open)\n",
			"http://127.0.0.1:8765/"
		);
	}
	if (Object.hasOwn(launch, "dev:laya")) {
		add(
			"scripts/laya_up.ps1",
			"dev:laya",
			'param([string]$Model = "artifacts/laya-live/laya-train/run1", [string]$Device = "cpu", [int]$Port = 8080)\nif ($Model -ne "artifacts/laya-live/laya-train/run1" -or $Device -ne "cpu" -or $Port -ne 8080) { throw "Set model, device and port in devhub.json." }\n'
		);
	}
	if (Object.hasOwn(launch, "dev:runtime")) {
		add(
			"scripts/local_up.ps1",
			"dev:runtime",
			'if ($args.Count -gt 0) { throw "Set local runtime parameters in devhub.json; prepare requirements separately." }\n'
		);
		if (existsSync(join(root, "scripts/local_up.sh"))) {
			launchers.push({
				content:
					'#!/usr/bin/env bash\nset -euo pipefail\nexec node "$(dirname "$0")/../.devhub/launch.cjs" dev:runtime "$@"\n',
				file: "scripts/local_up.sh",
			});
		}
	}
	if (existsSync(join(root, "scripts/qwen_image/start.ps1"))) {
		let generation = project.services.find(
			(service) => service.id === "generation"
		);
		if (!generation) {
			generation = {
				command:
					"uv run --no-sync uvicorn mediapipes.generation.app:create_app --factory --host 127.0.0.1 --port 8089",
				health: "/api/v1/health",
				id: "generation",
				name: "Qwen generation",
				port: 8089,
			};
			project.services.push(generation);
		}
		generation.env ??= {};
		generation.env.MEDIAPIPES_QWEN_ENABLED ??= "true";
		generation.env.MEDIAPIPES_QWEN_ROOT ??= "runtime/qwen-image";
		launch["dev:generation"] ??= ["generation"];
		add(
			"scripts/qwen_image/start.ps1",
			"dev:generation",
			'param([int]$Port = 8089, [switch]$Open)\nif ($Port -ne 8089) { throw "Set the Qwen port and command in devhub.json." }\n',
			"http://127.0.0.1:8089/qwen/"
		);
	}
	if (existsSync(join(root, "scripts/start_zemstroy.ps1"))) {
		if (!project.services.some((service) => service.id === "zemstroy-worker")) {
			project.services.push({
				command: "uv run --no-sync python -m mediapipes.integrations.zemstroy",
				id: "zemstroy-worker",
				name: "Zemstroy outbound worker",
				needs: [`${project.id}/api`],
			});
		}
		launch["dev:zemstroy"] ??= ["api", "zemstroy-worker"];
		add("scripts/start_zemstroy.ps1", "dev:zemstroy");
	}
	if (existsSync(join(root, "scripts/h3_local/studio_start.ps1"))) {
		const generation = project.services.find(
			(service) => service.id === "generation"
		);
		if (!generation) {
			throw new Error(`${root}: H3 studio requires the generation service`);
		}
		generation.env ??= {};
		generation.env.MEDIAPIPES_H3_LOCAL_ENABLED ??= "true";
		generation.env.MEDIAPIPES_H3_LOCAL_ROOT ??= ".";
		launch["dev:video"] ??= ["generation"];
		add(
			"scripts/h3_local/studio_start.ps1",
			"dev:video",
			'param([int]$Port = 8089, [switch]$Open)\nif ($Port -ne 8089) { throw "Set the H3 studio port in devhub.json." }\n',
			"http://127.0.0.1:8089/video/"
		);
	}
	return launchers;
}

function writeLaunchers(root: string, launchers: Launcher[]): void {
	const backup = join(root, ".devhub/original-launchers.json");
	const originals = existsSync(backup)
		? readJson<Record<string, string>>(backup)
		: {};
	for (const launcher of launchers) {
		const file = join(root, launcher.file);
		const current = readFileSync(file, "utf8");
		if (
			originals[launcher.file] &&
			current !== originals[launcher.file] &&
			current !== launcher.content
		) {
			throw new Error(
				`${file}: launcher changed since migration; preserve the change manually`
			);
		}
		originals[launcher.file] ??= current;
		if (current !== launcher.content) {
			writeFileSync(file, launcher.content);
		}
	}
	if (launchers.length) {
		writeFileSync(backup, serialize(originals));
	}
}

function localApiPort(root: string, service: Service): void {
	if (
		service.id !== "server" ||
		service.cwd !== "apps/server" ||
		!service.command?.includes("src/index.ts")
	) {
		return;
	}
	let port = service.port ?? 3000;
	for (const file of [".env.local", ".env"]) {
		const path = join(root, service.cwd, file);
		if (!existsSync(path)) {
			continue;
		}
		const match = LOCAL_PORT.exec(readFileSync(path, "utf8"));
		if (match) {
			port = Number(match[1]);
			break;
		}
	}
	service.env ??= {};
	service.env.PORT ??= String(port);
	service.port = Number(service.env.PORT);
}

function hubMetadata(service: Service): void {
	service.port ??= HUB_PORTS[service.id];
	service.env ??= {};
	if (service.id === "render") {
		service.env.PORT ??= "3008";
	}
	if (service.id === "personas") {
		service.env.RENDER_URL ??= "http://127.0.0.1:3008";
	}
}

function gameradarInfra(root: string, project: Project): void {
	if (
		!(
			(project.id === "gameradar" ||
				project.id === "legacy-gameradar-postgres-only-20260908") &&
			existsSync(join(root, "docker-compose.dev.yml"))
		)
	) {
		return;
	}
	project.compose ??= { file: "docker-compose.yml", project: project.id };
	project.compose.overrides ??= [];
	if (!project.compose.overrides.includes("docker-compose.dev.yml")) {
		project.compose.overrides.push("docker-compose.dev.yml");
	}
	project.compose.services = ["postgres", "redis"];
	const app = project.services.find((service) => service.id === "app");
	if (app) {
		app.needs ??= [];
		const need = `docker:${project.compose.project}`;
		if (!app.needs.includes(need)) {
			app.needs.push(need);
		}
	}
}

function predictMetadata(project: Project, service: Service): void {
	if (project.id !== "predict-paper") {
		return;
	}
	if (service.id === "runtime") {
		service.restart ??= "always";
		service.restartDelayMs ??= 30_000;
	}
}

function correctMetadata(root: string, project: Project): void {
	gameradarInfra(root, project);
	for (const service of project.services) {
		localApiPort(root, service);
		predictMetadata(project, service);
		if (project.id === "hub") {
			hubMetadata(service);
		}
		if (service.command === "uv run --no-sync mediapipes serve") {
			service.port ??= 8088;
			service.health ??= "/api/v1/health";
		}
		if (project.id === "montage" && service.id === "remix") {
			service.port ??= 8020;
		}
		if (project.id === "montage" && service.id === "videoparse") {
			service.port ??= 8010;
		}
		if (project.id === "gameradar" && service.id === "app") {
			service.name = "Витрина";
			service.description =
				"Локальный сервер Node.js; DevHub управляет запуском и остановкой.";
		}
		if (
			project.id === "legacy-gameradar-postgres-only-20260908" &&
			service.id === "app"
		) {
			service.port ??= 3000;
			service.health ??= "/readyz";
		}
	}
}

function writeMigration(
	root: string,
	project: Project,
	originals: Originals,
	edits: Edit[],
	template: string,
	launchers: Launcher[]
): void {
	const manifestFile = join(root, "devhub.json");
	const originalFile = join(root, ".devhub/original-scripts.json");
	mkdirSync(join(root, ".devhub"), { recursive: true });
	writeFileSync(manifestFile, serialize(project));
	writeFileSync(originalFile, serialize(originals));
	const launcher = join(root, ".devhub/launch.cjs");
	if (!existsSync(launcher) || readFileSync(launcher, "utf8") !== template) {
		const launcherBackup = join(root, ".devhub/original-launch.cjs");
		if (existsSync(launcher) && !existsSync(launcherBackup)) {
			writeFileSync(launcherBackup, readFileSync(launcher, "utf8"));
		}
		writeFileSync(launcher, template);
	}
	const readme = join(root, ".devhub/README.md");
	if (!existsSync(readme)) {
		writeFileSync(
			readme,
			`# Local development\n\nDev servers are owned by DevHub. Run the usual package dev command or \`node .devhub/launch.cjs dev\`; it asks DevHub to start the services in \`devhub.json\`. DevHub manages their lifecycle, dependencies, ports and logs. Set \`DEVHUB_ROOT\` when DevHub is outside a sibling \`devhub\` directory.\n\nEdit raw commands, relative working directories, environment overrides and script groups in \`devhub.json\`. Do not replace package dev scripts with standalone process spawners. The first original commands are preserved in \`original-scripts.json\`.\n\nProduction uses this project's own build, start and deploy commands and requires no DevHub files, installation, checkout or API. Expo start/web are development bundlers and therefore use DevHub.\n`
		);
	}
	const devPs = join(root, ".devhub/dev.ps1");
	if (!existsSync(devPs)) {
		writeFileSync(
			devPs,
			'param([string]$Script = "dev")\n& node (Join-Path $PSScriptRoot "launch.cjs") $Script\nexit $LASTEXITCODE\n'
		);
	}
	for (const edit of edits) {
		writeFileSync(edit.file, serialize(edit.data));
	}
	writeLaunchers(root, launchers);
	installProjectWorkflow(root);
}

function migrate(
	root: string,
	seed: Project | undefined,
	write: boolean,
	template: string
): MigrationResult | null {
	const originalFile = join(root, ".devhub/original-scripts.json");
	const originals: Originals = existsSync(originalFile)
		? readJson<Originals>(originalFile)
		: { packages: {}, version: 1 };
	const entries = packages(root, originals);
	const manifestFile = join(root, "devhub.json");
	if (existsSync(manifestFile) && !existsSync(originalFile)) {
		throw new Error(
			`${root}: devhub.json exists without migration originals; register its launch scripts manually`
		);
	}
	const project = existsSync(manifestFile)
		? readJson<Project>(manifestFile)
		: buildProject(root, seed, entries);
	if (project.services.length === 0) {
		return null;
	}
	const { count, edits } = packageEdits(root, project, entries, originals);
	const launchers = localLaunchers(root, project);
	correctMetadata(root, project);
	if (write) {
		writeMigration(root, project, originals, edits, template, launchers);
	}
	const policyFile = join(root, ".devhub", "worktree.json");
	const policy = existsSync(policyFile)
		? workflowPolicySchema.parse(readJson(policyFile))
		: null;
	return {
		id: project.id,
		scripts: count,
		services: project.services.length,
		workflow: {
			checksConfigured: (policy?.checks.length ?? 0) > 0,
			mode: policy?.mode ?? "mvp",
		},
	};
}

function scanProjects(
	scanRoot: string,
	catalogue: {
		aliases?: Record<string, string>;
		code: string;
		exclude?: string[];
		projects: Project[];
	},
	write: boolean,
	template: string
): MigrationResult[] {
	const report: MigrationResult[] = [];
	for (const root of directories(scanRoot)) {
		if (
			IGNORED_ROOT.test(basename(root)) ||
			!sameSourcePath(root, primaryCheckout(root)) ||
			[
				...(catalogue.exclude ?? []),
				...Object.keys(catalogue.aliases ?? {}),
			].some((folder) =>
				isInsideProject(
					resolve(hub, folder.replaceAll(CODE_TOKEN, catalogue.code)),
					root
				)
			)
		) {
			continue;
		}
		if (
			!(
				existsSync(join(root, "package.json")) ||
				existsSync(join(root, "pyproject.toml")) ||
				existsSync(join(root, "scripts/laya_up.ps1"))
			)
		) {
			continue;
		}
		let seed = catalogue.projects.find(
			(project) =>
				slash(
					resolve((project.path ?? "").replaceAll(CODE_TOKEN, catalogue.code))
				).toLowerCase() === slash(root).toLowerCase()
		);
		if (!seed && slash(scanRoot) !== "D:/code") {
			seed = {
				id: `legacy-${slug(basename(root))}`,
				name: `${basename(root)} (legacy checkout)`,
				services: [],
			};
		}
		const result = migrate(root, seed, write, template);
		if (result) {
			report.push({ root: slash(root), ...result });
		}
	}
	return report;
}

function main(): void {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const requestedRoots = args.flatMap((arg, index) =>
		arg === "--root" && args[index + 1]
			? [resolve(args[index + 1] as string)]
			: []
	);
	const roots = requestedRoots.length
		? requestedRoots
		: ["D:/code", "C:/Users/user/Documents/ChatGPT"];
	const catalogue = readJson<{
		aliases?: Record<string, string>;
		code: string;
		exclude?: string[];
		projects: Project[];
	}>(join(hub, "services.json"));
	const templateFile = join(hub, "templates/launch.cjs");
	if (write && !existsSync(templateFile)) {
		throw new Error(`Missing shared launcher ${templateFile}`);
	}
	const template = existsSync(templateFile)
		? readFileSync(templateFile, "utf8")
		: "";
	const report: MigrationResult[] = [];
	for (const scanRoot of roots) {
		report.push(...scanProjects(scanRoot, catalogue, write, template));
	}
	process.stdout.write(serialize({ projects: report, write }));
}

if (import.meta.main) {
	main();
}
