import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "bun";

import { DEV_SERVER_MARKER } from "../src/agents";
import { type Catalogue, manifestSchema } from "../src/config";
import {
	btsInput,
	type CreateJob,
	freePorts,
	ProjectCreator,
	type Runner,
	usedPorts,
	validateName,
	withEnv,
} from "../src/create";
import { WORKFLOW_POLICY_MARKER } from "../src/workflow-instructions";
import { workflowPolicySchema } from "../src/workflow-policy";

const HUB = resolve(import.meta.dir, "..");
const roots: string[] = [];
afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { force: true, recursive: true }))
	);
});

const readJson = async <T>(file: string): Promise<T> =>
	JSON.parse(await readFile(file, "utf8")) as T;

test("names, ports and env files are checked and edited conservatively", async () => {
	for (const name of ["my-app", "ab", "a1"]) {
		expect(() => validateName(name)).not.toThrow();
	}
	for (const name of ["My-App", "1app", "a", "app-", "a--b", "a_b", "../x"]) {
		expect(() => validateName(name)).toThrow();
	}
	expect(freePorts(new Set([3020, 3023]), 3020, 2)).toEqual([3024, 3025]);
	expect(freePorts(new Set([5433]), 5433, 1)).toEqual([5434]);
	expect(withEnv("A=1\nB=2\n", "B", "3")).toBe("A=1\nB=3\n");
	expect(withEnv("A=1", "C", "x")).toBe("A=1\nC=x\n");
	expect(withEnv("", "C", "$1")).toBe("C=$1\n");
	const input = btsInput("demo");
	expect(input).toMatchObject({
		api: "trpc",
		auth: "better-auth",
		backend: "hono",
		dbSetup: "docker",
		frontend: ["next"],
		git: false,
		install: true,
		projectName: "demo",
		serverDeploy: "docker",
		webDeploy: "docker",
	});
	const root = await mkdtemp(join(tmpdir(), "devhub-ports-"));
	roots.push(root);
	await writeFile(
		join(root, "docker-compose.yml"),
		'services:\n  postgres:\n    ports:\n      - "5432:5432"\n'
	);
	const used = await usedPorts({
		aliases: {},
		code: root,
		discover: [],
		exclude: [],
		port: 4700,
		projects: [
			{
				compose: {
					file: "docker-compose.yml",
					overrides: [],
					project: "x",
					services: [],
				},
				id: "x",
				launch: {},
				name: "x",
				path: root,
				services: [
					{
						env: {},
						host: "127.0.0.1",
						id: "web",
						name: "web",
						needs: [],
						port: 3001,
						restart: "never",
						restartDelayMs: 30_000,
						ui: [],
					},
				],
			},
		],
	});
	expect([...used].sort()).toEqual([3001, 4700, 5432]);
});

async function waitFor(
	creator: ProjectCreator,
	id: string
): Promise<CreateJob> {
	for (;;) {
		const job = creator.job(id);
		if (job && job.status !== "running") {
			return job;
		}
		// biome-ignore lint/performance/noAwaitInLoops: polling a background job in a test
		await sleep(10);
	}
}

function setup() {
	return mkdtemp(join(tmpdir(), "devhub-create-")).then(async (root) => {
		roots.push(root);
		const code = join(root, "code");
		await mkdir(code, { recursive: true });
		const catalogue: Catalogue = {
			aliases: {},
			code,
			discover: [code],
			exclude: [],
			port: 4700,
			projects: [],
		};
		return { catalogue, code };
	});
}

test("a Python project is written, registered and committed through the runner", async () => {
	const { catalogue, code } = await setup();
	const commands: string[][] = [];
	let registered = 0;
	const runner: Runner = (command) => {
		commands.push(command);
		return Promise.resolve(0);
	};
	const creator = new ProjectCreator({
		catalogue: () => catalogue,
		hubRoot: HUB,
		registered: () => {
			registered += 1;
			return Promise.resolve();
		},
		runner,
	});
	const started = creator.start({
		description: "Заметки",
		name: "notes-api",
		template: "python",
		web: true,
	});
	expect(() =>
		creator.start({ name: "notes-api", template: "python" })
	).toThrow("уже создаётся");
	const job = await waitFor(creator, started.id);
	expect(job.error).toBeNull();
	expect(job.status).toBe("done");
	expect(registered).toBe(1);
	const root = join(code, "notes-api");
	const manifest = manifestSchema.parse(
		await readJson(join(root, "devhub.json"))
	);
	expect(manifest.id).toBe("notes-api");
	expect(manifest.services[0]).toMatchObject({
		health: "/health",
		id: "api",
		port: 8100,
	});
	expect(manifest.services[0]?.command).toContain(
		"uvicorn notes_api.app:app --reload --host 127.0.0.1 --port 8100"
	);
	const policy = workflowPolicySchema.parse(
		await readJson(join(root, ".devhub", "worktree.json"))
	);
	expect(policy).toMatchObject({ mode: "mvp", remote: null });
	expect(policy.checks).toContain("uv run pytest -q");
	const agents = await readFile(join(root, "AGENTS.md"), "utf8");
	expect(agents).toContain(`BEGIN:${DEV_SERVER_MARKER}`);
	expect(agents).toContain(`BEGIN:${WORKFLOW_POLICY_MARKER}`);
	const launch = await readJson<{
		configurations: { runtimeArgs: string[] }[];
	}>(join(root, ".claude", "launch.json"));
	expect(launch.configurations[0]?.runtimeArgs.slice(1)).toEqual([
		"attach",
		"notes-api/api",
	]);
	expect(existsSync(join(root, "Dockerfile"))).toBe(true);
	expect(existsSync(join(root, "src", "notes_api", "app.py"))).toBe(true);
	expect(commands.map((command) => command.slice(0, 2).join(" "))).toEqual([
		"uv sync",
		"uv run",
		"git init",
		"git add",
		"git commit",
	]);
	expect(() =>
		creator.start({ name: "notes-api", template: "python" })
	).toThrow("уже существует");
});

test("a Better-T-Stack project gets free ports, DevHub launch scripts and honest checks", async () => {
	const { catalogue, code } = await setup();
	const commands: string[][] = [];
	const runner: Runner = async (command, { cwd }) => {
		commands.push(command);
		if (command.includes("create-json")) {
			const root = join(cwd, "shop");
			await mkdir(join(root, "apps", "server"), { recursive: true });
			await mkdir(join(root, "apps", "web"), { recursive: true });
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({
					scripts: {
						build: "turbo run build",
						dev: "turbo run dev",
						"dev:server": "turbo run dev -F server --",
						"dev:web": "turbo run dev -F web --",
					},
				})
			);
			await writeFile(
				join(root, "apps", "server", "package.json"),
				JSON.stringify({ scripts: { dev: "bun run --hot src/index.ts" } })
			);
			await writeFile(
				join(root, "apps", "web", "package.json"),
				JSON.stringify({ scripts: { dev: "next dev --port 3001" } })
			);
			await writeFile(
				join(root, "apps", "server", ".env"),
				"BETTER_AUTH_SECRET=x\nBETTER_AUTH_URL=http://localhost:3000\nCORS_ORIGIN=http://localhost:3001\n\nDATABASE_URL=postgresql://postgres:password@localhost:5432/shop\n"
			);
			await writeFile(
				join(root, "apps", "web", ".env"),
				"NEXT_PUBLIC_SERVER_URL=http://localhost:3000\n"
			);
			await writeFile(
				join(root, "docker-compose.yml"),
				'services:\n  postgres:\n    ports:\n      - "5432:5432"\n'
			);
		}
		// The generated template does not pass Ultracite yet.
		return command.at(-1) === "check" ? 1 : 0;
	};
	const creator = new ProjectCreator({
		catalogue: () => catalogue,
		hubRoot: HUB,
		registered: () => Promise.resolve(),
		runner,
	});
	const job = await waitFor(
		creator,
		creator.start({ name: "shop", template: "bts" }).id
	);
	expect(job.error).toBeNull();
	const root = join(code, "shop");
	const manifest = manifestSchema.parse(
		await readJson(join(root, "devhub.json"))
	);
	expect(
		manifest.services.map((service) => [service.id, service.port])
	).toEqual([
		["server", 3020],
		["web", 3021],
	]);
	expect(manifest.compose).toMatchObject({
		project: "shop",
		services: ["postgres"],
	});
	expect(manifest.launch.dev).toEqual(["server", "web"]);
	const pkg = await readJson<{ scripts: Record<string, string> }>(
		join(root, "package.json")
	);
	expect(pkg.scripts).toMatchObject({
		build: "turbo run build",
		dev: "node .devhub/launch.cjs dev",
		worktree: "node .devhub/worktree.cjs",
	});
	const originals = await readJson<{
		packages: Record<string, Record<string, string>>;
	}>(join(root, ".devhub", "original-scripts.json"));
	expect(originals.packages["apps/web/package.json"]).toEqual({
		dev: "next dev --port 3001",
	});
	const serverEnv = await readFile(join(root, "apps/server/.env"), "utf8");
	expect(serverEnv).toContain("BETTER_AUTH_URL=http://localhost:3020");
	expect(serverEnv).toContain("CORS_ORIGIN=http://localhost:3021");
	expect(serverEnv).toContain("localhost:5433/shop");
	expect(serverEnv).toContain("BETTER_AUTH_SECRET=x");
	expect(await readFile(join(root, "apps/web/.env"), "utf8")).toBe(
		"NEXT_PUBLIC_SERVER_URL=http://localhost:3020\n"
	);
	expect(await readFile(join(root, "docker-compose.yml"), "utf8")).toContain(
		'"5433:5432"'
	);
	const policy = workflowPolicySchema.parse(
		await readJson(join(root, ".devhub", "worktree.json"))
	);
	expect(policy.checks).toEqual(["bun run check-types", "bun run build"]);
	expect(existsSync(join(root, ".devhub", "launch.cjs"))).toBe(true);
	expect(existsSync(join(root, ".devhub", "worktree.cjs"))).toBe(true);
	const generator = commands.find((command) => command.includes("create-json"));
	expect(JSON.parse(generator?.at(-1) ?? "{}")).toMatchObject({
		projectName: "shop",
	});
});
