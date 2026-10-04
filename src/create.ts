import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "bun";

import {
	claudeLaunchConfig,
	devServerBlock,
	replaceMarkedBlock,
} from "./agents";
import type { Catalogue } from "./config";
import {
	ownerProjectPolicyBlock,
	replaceOwnerPolicyBlock,
} from "./workflow-instructions";

/**
 * New projects, created by their own generators and registered with DevHub in the same step: a Better-T-Stack
 * monorepo (Next.js, Hono, tRPC, Better Auth, Drizzle with Postgres in Docker, Dockerfiles for production) or a
 * clean Python project managed by uv. Each one gets free dev ports, `devhub.json`, the dev launcher, an MVP
 * workflow policy without a remote, agent instructions and a first commit on `main`.
 */

export type Template = "bts" | "python";

export interface CreateRequest {
	description?: string;
	name: string;
	template: Template;
	/** Python only: a FastAPI service with a health check; without it a plain package. */
	web?: boolean;
}

export interface CreateJob {
	error: string | null;
	finishedAt: number | null;
	id: string;
	log: string;
	name: string;
	path: string;
	/** The devhub project id, once it is registered. */
	project: string | null;
	startedAt: number;
	status: "running" | "done" | "failed";
	template: Template;
}

export type Runner = (
	command: string[],
	options: { cwd: string; onOutput: (text: string) => void }
) => Promise<number>;

const NAME = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const PUBLISHED_PORT = /["'\s-](\d{2,5}):\d{2,5}["'\s]/g;
const POSTGRES_PORT = /(["'\s-])5432:5432(["'\s])/;
const LOG_LIMIT = 200_000;
const FIRST_APP_PORT = 3020;
const FIRST_DB_PORT = 5433;
const HUB_PORT = 4700;
const BTS_ADDONS = [
	"turborepo",
	"biome",
	"ultracite",
	"lefthook",
	"evlog",
	"skills",
	"mcp",
];
const BTS_MCP = [
	"better-t-stack",
	"context7",
	"shadcn",
	"next-devtools",
	"better-auth",
];

const serialize = (value: unknown): string =>
	`${JSON.stringify(value, null, 2)}\n`;
const slash = (path: string): string => path.replaceAll("\\", "/");

export function validateName(name: string): void {
	if (!NAME.test(name) || name.includes("--")) {
		throw new Error(
			"Имя проекта: латиница в нижнем регистре, цифры и дефис, 2–40 символов, начинается с буквы"
		);
	}
}

/** The Better-T-Stack input: the owner's stack, the same as analytics and brains. */
export function btsInput(name: string): Record<string, unknown> {
	return {
		addonOptions: {
			mcp: {
				agents: ["claude-code", "codex", "cursor"],
				scope: "project",
				servers: BTS_MCP,
			},
			skills: { agents: ["universal", "claude-code"], scope: "project" },
			ultracite: {
				agents: ["claude", "codex"],
				editors: ["vscode", "cursor"],
				hooks: ["claude"],
				linter: "biome",
			},
		},
		addons: BTS_ADDONS,
		api: "trpc",
		auth: "better-auth",
		backend: "hono",
		database: "postgres",
		dbSetup: "docker",
		directoryConflict: "error",
		disableAnalytics: true,
		examples: [],
		frontend: ["next"],
		git: false,
		install: true,
		orm: "drizzle",
		packageManager: "bun",
		payments: "none",
		projectName: name,
		renderTitle: false,
		runtime: "bun",
		serverDeploy: "docker",
		webDeploy: "docker",
	};
}

/** Ports already promised to catalogued services and published by projects' compose files. */
export async function usedPorts(catalogue: Catalogue): Promise<Set<number>> {
	const used = new Set<number>([HUB_PORT, catalogue.port]);
	for (const project of catalogue.projects) {
		for (const service of project.services) {
			if (service.port) {
				used.add(service.port);
			}
		}
		// biome-ignore lint/suspicious/noTemplateCurlyInString: machine catalogue placeholder
		const root = resolve(project.path.replaceAll("${code}", catalogue.code));
		const files = project.compose
			? [project.compose.file, ...project.compose.overrides]
			: [];
		for (const file of files) {
			// biome-ignore lint/performance/noAwaitInLoops: a handful of small compose files
			const text = await readFile(join(root, file), "utf8").catch(() => "");
			for (const match of text.matchAll(PUBLISHED_PORT)) {
				used.add(Number(match[1]));
			}
		}
	}
	return used;
}

/** The first `count` consecutive free ports from `first` on. */
export function freePorts(
	used: Set<number>,
	first: number,
	count: number
): number[] {
	for (let port = first; port < 65_000; port += count) {
		const ports = Array.from({ length: count }, (_, index) => port + index);
		if (ports.every((entry) => !used.has(entry))) {
			return ports;
		}
	}
	throw new Error("нет свободных портов");
}

/** Set `KEY=value` in a dotenv file, keeping its other lines. */
export function withEnv(text: string, key: string, value: string): string {
	const pattern = new RegExp(`^${key}=.*$`, "m");
	if (pattern.test(text)) {
		return text.replace(pattern, () => `${key}=${value}`);
	}
	const end = text && !text.endsWith("\n") ? "\n" : "";
	return `${text}${end}${key}=${value}\n`;
}

async function editEnv(
	file: string,
	values: Record<string, string>
): Promise<void> {
	let text = await readFile(file, "utf8").catch(() => "");
	for (const [key, value] of Object.entries(values)) {
		text = withEnv(text, key, value);
	}
	await writeFile(file, text);
}

async function editJson<T>(file: string, edit: (value: T) => void) {
	const value = JSON.parse(await readFile(file, "utf8")) as T;
	edit(value);
	await writeFile(file, serialize(value));
}

interface Package {
	scripts?: Record<string, string>;
}

function workflowPolicy(name: string, checks: string[]) {
	return {
		checks,
		mode: "mvp",
		releaseBranch: "main",
		remote: null,
		stageBranch: "stage",
		version: 1,
		worktreeRoot: `D:/worktrees/${name}`,
	};
}

const DEVHUB_README = `# Local development

Dev servers are owned by DevHub. Run the usual package dev command or \`node .devhub/launch.cjs dev\`; it asks DevHub to start the services in \`devhub.json\`. DevHub manages their lifecycle, dependencies, ports and logs. Set \`DEVHUB_ROOT\` when DevHub is outside a sibling \`devhub\` directory.

Edit raw commands, relative working directories, environment overrides and script groups in \`devhub.json\`. Do not replace package dev scripts with standalone process spawners. The first original commands are preserved in \`original-scripts.json\`.

Production uses this project's own build, start and deploy commands and requires no DevHub files, installation, checkout or API.
`;

/** DevHub's files in a new project: launcher, policy, agent instructions and browser-pane configuration. */
async function installDevhub(
	root: string,
	hubRoot: string,
	project: { id: string; services: { id: string; port?: number }[] },
	checks: string[],
	originals: Record<string, Record<string, string>>
): Promise<void> {
	await mkdir(join(root, ".devhub"), { recursive: true });
	await mkdir(join(root, ".claude"), { recursive: true });
	const template = (file: string) =>
		readFile(join(hubRoot, "templates", file), "utf8");
	await writeFile(
		join(root, ".devhub", "launch.cjs"),
		await template("launch.cjs")
	);
	await writeFile(join(root, ".devhub", "README.md"), DEVHUB_README);
	await writeFile(
		join(root, ".devhub", "dev.ps1"),
		'param([string]$Script = "dev")\n& node (Join-Path $PSScriptRoot "launch.cjs") $Script\nexit $LASTEXITCODE\n'
	);
	await writeFile(
		join(root, ".devhub", "dev.sh"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a POSIX shell default, not a template
		'#!/usr/bin/env sh\nexec node "$(dirname "$0")/launch.cjs" "${1:-dev}"\n'
	);
	await writeFile(
		join(root, ".devhub", "original-scripts.json"),
		serialize({ packages: originals, version: 1 })
	);
	await writeFile(
		join(root, ".devhub", "worktree.json"),
		serialize(workflowPolicy(project.id, checks))
	);
	if (existsSync(join(root, "package.json"))) {
		await writeFile(
			join(root, ".devhub", "worktree.cjs"),
			await template("worktree.cjs")
		);
	}
	await writeFile(
		join(root, ".claude", "launch.json"),
		serialize(claudeLaunchConfig(hubRoot, project))
	);
	const agents = join(root, "AGENTS.md");
	const before = await readFile(agents, "utf8").catch(() => "");
	const withDev = replaceMarkedBlock(before, devServerBlock(hubRoot));
	await writeFile(
		agents,
		replaceOwnerPolicyBlock(withDev, ownerProjectPolicyBlock(root))
	);
}

export interface Ports {
	db: number;
	server: number;
	web: number;
}

/** Register a generated Better-T-Stack project: ports, devhub.json, launch scripts and DevHub files. */
export async function adoptBts(
	root: string,
	hubRoot: string,
	name: string,
	ports: Ports,
	description?: string
): Promise<void> {
	const originals: Record<string, Record<string, string>> = {};
	const wrap = async (
		file: string,
		scripts: Record<string, string>
	): Promise<void> => {
		const path = join(root, file);
		if (!existsSync(path)) {
			return;
		}
		await editJson<Package>(path, (pkg) => {
			pkg.scripts ??= {};
			for (const [key, wrapper] of Object.entries(scripts)) {
				const original = pkg.scripts[key];
				if (original) {
					originals[file] ??= {};
					originals[file][key] = original;
				}
				pkg.scripts[key] = wrapper;
			}
			if (file === "package.json") {
				pkg.scripts.worktree = "node .devhub/worktree.cjs";
			}
		});
	};
	await wrap("package.json", {
		dev: "node .devhub/launch.cjs dev",
		"dev:server": "node .devhub/launch.cjs dev:server",
		"dev:web": "node .devhub/launch.cjs dev:web",
	});
	await wrap("apps/server/package.json", {
		dev: "node ../../.devhub/launch.cjs apps/server:dev",
	});
	await wrap("apps/web/package.json", {
		dev: "node ../../.devhub/launch.cjs apps/web:dev",
	});
	const local = (port: number) => `http://localhost:${port}`;
	await editEnv(join(root, "apps/server/.env"), {
		BETTER_AUTH_URL: local(ports.server),
		CORS_ORIGIN: local(ports.web),
		DATABASE_URL: `postgresql://postgres:password@localhost:${ports.db}/${name}`,
	});
	await editEnv(join(root, "apps/web/.env"), {
		NEXT_PUBLIC_SERVER_URL: local(ports.server),
	});
	const compose = join(root, "docker-compose.yml");
	if (existsSync(compose)) {
		const text = await readFile(compose, "utf8");
		await writeFile(
			compose,
			text.replace(POSTGRES_PORT, `$1${ports.db}:5432$2`)
		);
	}
	const manifest = {
		compose: {
			file: "docker-compose.yml",
			project: name,
			services: ["postgres"],
		},
		...(description ? { description } : {}),
		id: name,
		launch: {
			"apps/server:dev": ["server"],
			"apps/web:dev": ["web"],
			dev: ["server", "web"],
			"dev:server": ["server"],
			"dev:web": ["web"],
		},
		name,
		services: [
			{
				command: "bun run --hot src/index.ts",
				cwd: "apps/server",
				env: { PORT: String(ports.server) },
				id: "server",
				name: "server",
				needs: [`docker:${name}`],
				port: ports.server,
			},
			{
				command: `next dev --port ${ports.web}`,
				cwd: "apps/web",
				env: {},
				id: "web",
				name: "web",
				port: ports.web,
				ui: [{ label: "Приложение", url: "/" }],
			},
		],
	};
	await writeFile(join(root, "devhub.json"), serialize(manifest));
	await installDevhub(
		root,
		hubRoot,
		manifest,
		["bun run check-types", "bun run check", "bun run build"],
		originals
	);
}

/** Replace the final checks of a new project's workflow policy. */
export async function setChecks(root: string, checks: string[]): Promise<void> {
	await editJson<{ checks: string[] }>(
		join(root, ".devhub", "worktree.json"),
		(policy) => {
			policy.checks = checks;
		}
	);
}

const pythonModule = (name: string): string => name.replaceAll("-", "_");

/** A clean uv project; with `web` a FastAPI service DevHub runs on a free port, otherwise a plain package. */
export async function writePython(
	root: string,
	hubRoot: string,
	name: string,
	port: number,
	options: { description?: string; web: boolean }
): Promise<void> {
	const module = pythonModule(name);
	const about = options.description ?? `${name}`;
	const dependencies = options.web
		? '["fastapi>=0.115", "uvicorn[standard]>=0.32"]'
		: "[]";
	const testDependencies = options.web
		? '"httpx>=0.28", "pytest>=8.3", "ruff>=0.8"'
		: '"pytest>=8.3", "ruff>=0.8"';
	const files: Record<string, string> = {
		".dockerignore":
			".venv\n.git\n.devhub\n.claude\n**/__pycache__\n.pytest_cache\n.ruff_cache\n",
		".gitignore":
			".venv/\n__pycache__/\n*.py[cod]\n.pytest_cache/\n.ruff_cache/\ndist/\nbuild/\n*.egg-info/\n.env\n.env.*\n!.env.example\n",
		".python-version": "3.12\n",
		"pyproject.toml": `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "${about.replaceAll('"', '\\"')}"\nreadme = "README.md"\nrequires-python = ">=3.12"\ndependencies = ${dependencies}\n\n[project.scripts]\n${name} = "${module}.__main__:main"\n\n[dependency-groups]\ndev = [${testDependencies}]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[tool.hatch.build.targets.wheel]\npackages = ["src/${module}"]\n\n[tool.ruff]\nline-length = 100\n\n[tool.ruff.lint]\nselect = ["E", "F", "I", "UP", "B"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
		"README.md": `# ${name}\n\n${about}\n\n## Development\n\n\`\`\`sh\nuv sync\n${options.web ? "node .devhub/launch.cjs dev  # DevHub starts the API; on Windows also .devhub/dev.ps1\n" : `uv run python -m ${module}\n`}uv run pytest\nuv run ruff check .\n\`\`\`\n\n${options.web ? `DevHub runs the API on http://127.0.0.1:${port}/ (docs at /docs). ` : ""}Production uses the Dockerfile and does not depend on DevHub.\n`,
		[`src/${module}/__init__.py`]: `"""${about}"""\n`,
		[`src/${module}/__main__.py`]: options.web
			? `import os\n\nimport uvicorn\n\n\ndef main() -> None:\n    uvicorn.run(\n        "${module}.app:app",\n        host=os.environ.get("HOST", "0.0.0.0"),\n        port=int(os.environ.get("PORT", "8000")),\n    )\n\n\nif __name__ == "__main__":\n    main()\n`
			: `def main() -> None:\n    print("${name}")\n\n\nif __name__ == "__main__":\n    main()\n`,
		"tests/test_smoke.py": options.web
			? `from fastapi.testclient import TestClient\n\nfrom ${module}.app import app\n\n\ndef test_health() -> None:\n    response = TestClient(app).get("/health")\n    assert response.status_code == 200\n    assert response.json() == {"ok": True}\n`
			: `from ${module}.__main__ import main\n\n\ndef test_main(capsys) -> None:\n    main()\n    assert capsys.readouterr().out.strip() == "${name}"\n`,
	};
	if (options.web) {
		files[`src/${module}/app.py`] =
			`from fastapi import FastAPI\n\napp = FastAPI(title="${name}")\n\n\n@app.get("/health")\ndef health() -> dict[str, bool]:\n    return {"ok": True}\n\n\n@app.get("/")\ndef index() -> dict[str, str]:\n    return {"name": "${name}"}\n`;
		files.Dockerfile = `FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim\nWORKDIR /app\nENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1\nCOPY pyproject.toml uv.lock README.md ./\nRUN uv sync --frozen --no-dev --no-install-project\nCOPY src ./src\nRUN uv sync --frozen --no-dev\nENV PATH="/app/.venv/bin:$PATH" PORT=8000\nEXPOSE 8000\nHEALTHCHECK CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\\"PORT\\",\\"8000\\")}/health')"\nCMD ["python", "-m", "${module}"]\n`;
	}
	for (const [file, content] of Object.entries(files)) {
		// biome-ignore lint/performance/noAwaitInLoops: nested folders are created in order
		await mkdir(join(root, file, ".."), { recursive: true });
		await writeFile(join(root, file), content);
	}
	const manifest = {
		...(options.description ? { description: options.description } : {}),
		id: name,
		launch: options.web ? { dev: ["api"], "dev:api": ["api"] } : {},
		name,
		services: options.web
			? [
					{
						command: `uv run --no-sync uvicorn ${module}.app:app --reload --host 127.0.0.1 --port ${port}`,
						env: { PYTHONUTF8: "1" },
						health: "/health",
						id: "api",
						name: "API",
						port,
						ui: [
							{ label: "API", url: "/" },
							{ label: "Документация API", url: "/docs" },
						],
					},
				]
			: [],
	};
	await writeFile(join(root, "devhub.json"), serialize(manifest));
	await installDevhub(
		root,
		hubRoot,
		manifest,
		["uv run ruff check .", "uv run ruff format --check .", "uv run pytest -q"],
		{}
	);
}

export const spawnRunner: Runner = async (command, { cwd, onOutput }) => {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("DEVHUB_")) {
			environment[key] = value;
		}
	}
	environment.NO_COLOR = "1";
	environment.FORCE_COLOR = "0";
	environment.CI = "1";
	const child = spawn(command, {
		cwd,
		env: environment,
		stderr: "pipe",
		stdin: "ignore",
		stdout: "pipe",
		windowsHide: true,
	});
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			onOutput(decoder.decode(chunk, { stream: true }));
		}
	};
	await Promise.all([pump(child.stdout), pump(child.stderr), child.exited]);
	return child.exitCode ?? 1;
};

/** Project creation as background jobs the page and the CLI follow. */
export class ProjectCreator {
	private readonly jobs = new Map<string, CreateJob>();
	private readonly catalogue: () => Catalogue;
	private readonly hubRoot: string;
	private readonly registered: () => Promise<void>;
	private readonly run: Runner;

	constructor(options: {
		catalogue: () => Catalogue;
		hubRoot: string;
		/** Called after the files are written: the hub reloads its catalogue. */
		registered: () => Promise<void>;
		runner?: Runner;
	}) {
		this.catalogue = options.catalogue;
		this.hubRoot = options.hubRoot;
		this.registered = options.registered;
		this.run = options.runner ?? spawnRunner;
	}

	job(id: string): CreateJob | null {
		return this.jobs.get(id) ?? null;
	}

	list(): CreateJob[] {
		return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Checks the request and starts the job; the job itself reports how it ended. */
	start(request: CreateRequest): CreateJob {
		validateName(request.name);
		if (request.template !== "bts" && request.template !== "python") {
			throw new Error("Шаблон: bts или python");
		}
		const catalogue = this.catalogue();
		const code = resolve(catalogue.code);
		const path = join(code, request.name);
		if (existsSync(path)) {
			throw new Error(`Папка ${slash(path)} уже существует`);
		}
		if (catalogue.projects.some((project) => project.id === request.name)) {
			throw new Error(`Проект ${request.name} уже есть в пульте`);
		}
		if (
			[...this.jobs.values()].some(
				(entry) => entry.status === "running" && entry.name === request.name
			)
		) {
			throw new Error(`Проект ${request.name} уже создаётся`);
		}
		const job: CreateJob = {
			error: null,
			finishedAt: null,
			id: randomUUID(),
			log: "",
			name: request.name,
			path: slash(path),
			project: null,
			startedAt: Date.now(),
			status: "running",
			template: request.template,
		};
		this.jobs.set(job.id, job);
		this.execute(job, request, code, catalogue).then(
			() => {
				job.status = "done";
				job.project = request.name;
				job.finishedAt = Date.now();
				this.say(job, `\nГотово: ${job.path} подключён к пульту.\n`);
			},
			(error: unknown) => {
				job.status = "failed";
				job.error = (error as Error).message;
				job.finishedAt = Date.now();
				this.say(job, `\nОшибка: ${job.error}\n`);
			}
		);
		return job;
	}

	private say(job: CreateJob, text: string): void {
		job.log = (job.log + text).slice(-LOG_LIMIT);
	}

	private async step(
		job: CreateJob,
		command: string[],
		cwd: string,
		optional = false
	): Promise<number> {
		this.say(job, `\n$ ${command.join(" ")}\n`);
		const code = await this.run(command, {
			cwd,
			onOutput: (text) => this.say(job, text),
		});
		if (code !== 0 && !optional) {
			throw new Error(
				`${command.slice(0, 3).join(" ")} завершилась с кодом ${code}`
			);
		}
		return code;
	}

	private async execute(
		job: CreateJob,
		request: CreateRequest,
		code: string,
		catalogue: Catalogue
	): Promise<void> {
		const used = await usedPorts(catalogue);
		const bun = process.execPath;
		if (request.template === "bts") {
			const [server = 0, web = 0] = freePorts(used, FIRST_APP_PORT, 2);
			const [db = 0] = freePorts(used, FIRST_DB_PORT, 1);
			this.say(
				job,
				`Better-T-Stack ${request.name}: server :${server}, web :${web}, Postgres :${db}\n`
			);
			await this.step(
				job,
				[
					bun,
					"x",
					"--bun",
					"create-better-t-stack@latest",
					"create-json",
					"--json",
					JSON.stringify(btsInput(request.name)),
				],
				code
			);
			if (!existsSync(join(job.path, "package.json"))) {
				throw new Error("Better-T-Stack не создал проект");
			}
			await adoptBts(
				job.path,
				this.hubRoot,
				request.name,
				{ db, server, web },
				request.description
			);
			await this.step(job, [bun, "run", "fix"], job.path, true);
			// Ultracite is stricter than the generated template: keep it as a gate only once it passes.
			if ((await this.step(job, [bun, "run", "check"], job.path, true)) !== 0) {
				await setChecks(job.path, ["bun run check-types", "bun run build"]);
				this.say(
					job,
					"\nUltracite находит замечания в коде шаблона: исправьте их и добавьте bun run check в .devhub/worktree.json.\n"
				);
			}
		} else {
			const [port = 0] = freePorts(used, 8100, 1);
			const web = request.web !== false;
			this.say(job, `Python ${request.name}${web ? `: API :${port}` : ""}\n`);
			await mkdir(job.path, { recursive: true });
			await writePython(job.path, this.hubRoot, request.name, port, {
				description: request.description,
				web,
			});
			await this.step(job, ["uv", "sync"], job.path);
			await this.step(
				job,
				["uv", "run", "ruff", "format", "."],
				job.path,
				true
			);
		}
		await this.step(job, ["git", "init", "-b", "main"], job.path);
		await this.step(job, ["git", "add", "-A"], job.path);
		await this.step(
			job,
			[
				"git",
				"commit",
				"-m",
				`Create ${request.name} (${request.template === "bts" ? "Better-T-Stack" : "Python"}) with DevHub`,
			],
			job.path
		);
		this.say(job, "\nРегистрирую в пульте…\n");
		await this.registered();
	}
}
