import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	attachesToDevhub,
	claudeLaunchConfig,
	DEV_SERVER_MARKER,
	devServerBlock,
	directDevServer,
	guardReason,
	replaceMarkedBlock,
} from "../src/agents";

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { force: true, recursive: true }))
	);
});

test("dev servers started around DevHub are recognised; builds, tests and DevHub entrypoints pass", () => {
	for (const command of [
		"cd apps/web && next dev --port 3001",
		"bunx vite",
		"npx vite --host",
		"pnpm exec vite dev",
		"bun --hot src/index.ts",
		"bun run --hot src/index.ts &",
		"node --watch server.mjs",
		"nodemon app.js",
		"tsx watch src/main.ts",
		"turbo run dev -F web",
		"uv run uvicorn app.main:app --reload --port 8000",
		"fastapi dev main.py",
		"wrangler dev",
		"npx expo start",
		"python manage.py runserver",
	]) {
		expect([command, directDevServer(command)]).not.toEqual([command, null]);
	}
	for (const command of [
		"bun run dev",
		"bun run dev:web",
		"next build",
		"vite build",
		"bun test --watch",
		"bun --watch test",
		"turbo run build",
		"uv run uvicorn app.main:app --port 8000",
		"bun D:/code/devhub/src/cli.ts start altay/site",
		"node .devhub/launch.cjs dev",
	]) {
		expect([command, directDevServer(command)]).toEqual([command, null]);
	}
});

test("the guard refuses direct dev servers only inside DevHub projects", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-guard-"));
	roots.push(root);
	const project = join(root, "demo");
	const outside = join(root, "scratch");
	await mkdir(join(project, "apps", "web"), { recursive: true });
	await mkdir(join(project, ".claude"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(project, "devhub.json"), "{}");
	await writeFile(
		join(project, ".claude", "launch.json"),
		JSON.stringify({
			configurations: [
				{
					name: "site",
					runtimeArgs: ["--watch", "server.mjs"],
					runtimeExecutable: "node",
				},
				{
					name: "web",
					runtimeArgs: ["D:/code/devhub/src/cli.ts", "attach", "demo/web"],
					runtimeExecutable: "bun",
				},
				{ name: "open", url: "http://localhost:3001" },
			],
		})
	);
	const nested = join(project, "apps", "web");
	expect(
		guardReason(
			{ cwd: nested, tool_input: { command: "next dev" }, tool_name: "Bash" },
			"D:/code/devhub"
		)
	).toContain("bun D:/code/devhub/src/cli.ts start");
	expect(
		guardReason(
			{
				cwd: nested,
				tool_input: { command: "next build" },
				tool_name: "PowerShell",
			},
			"D:/code/devhub"
		)
	).toBeNull();
	expect(
		guardReason(
			{ cwd: outside, tool_input: { command: "next dev" }, tool_name: "Bash" },
			"D:/code/devhub"
		)
	).toBeNull();
	const preview = (name: string) =>
		guardReason(
			{
				cwd: project,
				tool_input: { name },
				tool_name: "mcp__Claude_Browser__preview_start",
			},
			"D:/code/devhub"
		);
	expect(preview("site")).toContain("outside DevHub");
	expect(preview("web")).toBeNull();
	expect(preview("open")).toBeNull();
	expect(preview("missing")).toBeNull();
});

test("launch configurations attach to DevHub for every service with a port", () => {
	const config = claudeLaunchConfig("D:\\code\\devhub", {
		id: "demo",
		services: [
			{ id: "server", port: 3020 },
			{ id: "worker" },
			{ id: "web", port: 3021 },
		],
	});
	expect(config.configurations.map((entry) => entry.name)).toEqual([
		"server",
		"web",
	]);
	expect(config.configurations[0]?.runtimeArgs).toEqual([
		"D:/code/devhub/src/cli.ts",
		"attach",
		"demo/server",
	]);
	expect(config.configurations.every(attachesToDevhub)).toBe(true);
	expect(
		attachesToDevhub({
			runtimeArgs: ["run", "dev:web"],
			runtimeExecutable: "bun",
		})
	).toBe(true);
	expect(
		attachesToDevhub({
			runtimeArgs: ["-Command", "bun x next dev --port 3011"],
			runtimeExecutable: "pwsh",
		})
	).toBe(false);
});

test("the DevHub block replaces itself and keeps the rest of the instructions", () => {
	const block = devServerBlock("D:\\code\\devhub");
	expect(block).toContain("bun D:/code/devhub/src/cli.ts start");
	expect(replaceMarkedBlock("", block)).toBe(`${block}\n`);
	const withFrontmatter = "---\ntitle: x\n---\n# Project\r\n";
	const once = replaceMarkedBlock("# Project\n\nRules.\n", block);
	expect(once).toBe(`${block}\n\n# Project\n\nRules.\n`);
	expect(replaceMarkedBlock(once, block)).toBe(once);
	const updated = replaceMarkedBlock(
		once,
		block.replace("owner policy", "rules")
	);
	expect(updated).toContain("rules, 2026");
	expect(
		updated.match(new RegExp(`BEGIN:${DEV_SERVER_MARKER}`, "g"))
	).toHaveLength(1);
	expect(
		replaceMarkedBlock(withFrontmatter, block).startsWith(
			"---\ntitle: x\n---\n<!--"
		)
	).toBe(true);
	expect(() =>
		replaceMarkedBlock(`<!-- BEGIN:${DEV_SERVER_MARKER} -->\nhalf`, block)
	).toThrow("незавершённый");
});
