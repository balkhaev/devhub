import { afterAll, expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { force: true, recursive: true }))
	);
});

test("development launcher delegates to devhub and propagates its result", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-launch-"));
	roots.push(root);
	const project = join(root, "demo");
	const hub = join(root, "hub");
	await Promise.all([
		mkdir(join(project, ".devhub"), { recursive: true }),
		mkdir(join(hub, "src"), { recursive: true }),
	]);
	await Promise.all([
		copyFile(
			join(import.meta.dir, "..", "templates", "launch.cjs"),
			join(project, ".devhub", "launch.cjs")
		),
		writeFile(
			join(project, "devhub.json"),
			JSON.stringify({ id: "demo", launch: { dev: ["web"] } })
		),
		writeFile(join(hub, "services.json"), "{}"),
		writeFile(
			join(hub, "src", "cli.ts"),
			"await Bun.write(process.env.RESULT_FILE!, JSON.stringify(process.argv.slice(2))); process.exit(7);"
		),
	]);
	const output = join(root, "result.json");
	const child = spawn(
		[process.execPath, join(project, ".devhub", "launch.cjs"), "dev"],
		{
			cwd: project,
			env: {
				...process.env,
				DEVHUB_BUN: process.execPath,
				DEVHUB_ROOT: hub,
				DEVHUB_SERVICE: "",
				RESULT_FILE: output,
			},
			stderr: "pipe",
			stdout: "pipe",
		}
	);
	expect(await child.exited).toBe(7);
	expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
		"start",
		"--project",
		project,
		"--script",
		"dev",
	]);
});

test("managed package scripts stay within their existing process tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-owned-launch-"));
	roots.push(root);
	await mkdir(join(root, ".devhub"));
	await Promise.all([
		copyFile(
			join(import.meta.dir, "..", "templates", "launch.cjs"),
			join(root, ".devhub", "launch.cjs")
		),
		writeFile(
			join(root, "devhub.json"),
			JSON.stringify({ id: "demo", launch: { "dev:worker": ["worker"] } })
		),
		writeFile(
			join(root, ".devhub", "original-scripts.json"),
			JSON.stringify({
				packages: {
					"package.json": {
						"dev:worker": `"${process.execPath}" -e "process.stdout.write('owned-worker')"`,
					},
				},
				version: 1,
			})
		),
	]);
	const child = spawn(
		[process.execPath, join(root, ".devhub", "launch.cjs"), "dev:worker"],
		{
			cwd: root,
			env: { ...process.env, DEVHUB_ROOT: root, DEVHUB_SERVICE: "demo/worker" },
			stderr: "pipe",
			stdout: "pipe",
		}
	);
	expect(await child.exited).toBe(0);
	expect(await new Response(child.stdout).text()).toBe("owned-worker");
});
