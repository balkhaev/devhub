import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "bun";

import {
	developmentSourceIssue,
	isInsideProject,
	primaryCheckout,
	sameSourcePath,
} from "../src/checkouts";
import { parseArguments, resolveTargets } from "../src/cli";
import {
	catalogueIssues,
	catalogueSchema,
	loadCatalogue,
	loadManifest,
	servicesOf,
} from "../src/config";
import { Processes } from "../src/processes";

const root = mkdtempSync(join(tmpdir(), "devhub-checkouts-"));
const main = join(root, "main");
const worktree = join(root, "worktree");
const legacy = join(root, "legacy");
const manifest = {
	id: "demo",
	launch: { "apps/web:dev": ["web"], dev: ["web"] },
	name: "Demo",
	services: [
		{ command: "node server.js", cwd: "apps/web", id: "web", name: "Web" },
	],
};

function git(args: string[]): void {
	const result = spawnSync("git", ["-C", main, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.error?.message || "Git fixture failed"
		);
	}
}

beforeAll(() => {
	mkdirSync(join(main, "apps/web"), { recursive: true });
	mkdirSync(join(main, ".devhub"));
	writeFileSync(join(main, "devhub.json"), JSON.stringify(manifest));
	writeFileSync(join(main, "apps/web/.keep"), "");
	copyFileSync(
		join(import.meta.dir, "../templates/launch.cjs"),
		join(main, ".devhub/launch.cjs")
	);
	git(["init", "-b", "main"]);
	git(["add", "."]);
	git([
		"-c",
		"user.name=DevHub Test",
		"-c",
		"user.email=devhub-test@example.invalid",
		"commit",
		"-m",
		"fixture",
	]);
	git(["worktree", "add", "--detach", worktree]);
	writeFileSync(
		join(worktree, "devhub.json"),
		JSON.stringify({
			...manifest,
			id: "old-demo",
			launch: { dev: ["obsolete"] },
		})
	);
	mkdirSync(legacy);
	writeFileSync(
		join(legacy, "devhub.json"),
		JSON.stringify({ ...manifest, id: "old-copy" })
	);
});

afterAll(() => {
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith("devhub-checkouts-")
	) {
		throw new Error("Unexpected fixture cleanup path");
	}
	rmSync(root, { force: true, recursive: true });
});

test("Git's common directory resolves a linked worktree and package folder to the primary checkout", async () => {
	expect(sameSourcePath(primaryCheckout(worktree), main)).toBe(true);
	expect(
		sameSourcePath(primaryCheckout(join(worktree, "apps/web")), main)
	).toBe(true);
	expect((await loadManifest(worktree)).id).toBe("demo");
	expect((await loadManifest(worktree)).path).toBe(main);
	expect(isInsideProject(main, join(main, "apps/web"))).toBe(true);
	expect(isInsideProject(main, worktree)).toBe(false);
});

test("discovery includes the primary checkout while skipping worktrees and aliased older copies", async () => {
	const file = join(root, "services.json");
	writeFileSync(
		file,
		JSON.stringify({
			aliases: { [legacy]: main },
			code: root,
			discover: [root],
			projects: [],
		})
	);
	const catalogue = await loadCatalogue(file);
	expect(catalogue.projects.map((project) => project.id)).toEqual(["demo"]);
	for (const path of [
		worktree,
		legacy,
		join(worktree, "apps/web"),
		join(legacy, "apps/web"),
	]) {
		// biome-ignore lint/performance/noAwaitInLoops: exercise each independent routing source
		const targets = await resolveTargets(
			catalogue,
			parseArguments(["start", "--project", path, "--script", "apps/web:dev"])
		);
		expect(targets).toEqual(["demo/web"]);
	}
});

test("machine exclusions apply to explicit project entries as well as discovery", async () => {
	const file = join(root, "excluded.json");
	writeFileSync(
		file,
		JSON.stringify({
			code: root,
			discover: [root],
			exclude: [legacy],
			projects: [{ ...manifest, id: "old-copy", path: legacy }],
		})
	);
	const catalogue = await loadCatalogue(file);
	expect(catalogue.projects.map((project) => project.id)).toEqual(["demo"]);
});

test("catalogue validation and process launch reject a worktree or a cwd outside the primary project", async () => {
	for (const [path, cwd] of [
		[worktree, undefined],
		[main, "../worktree"],
	]) {
		const catalogue = catalogueSchema.parse({
			projects: [
				{
					...manifest,
					path,
					services: [
						{ command: "node no-such-file.js", cwd, id: "web", name: "Web" },
					],
				},
			],
		});
		expect(
			catalogueIssues(catalogue).some((issue) => issue.includes("основн"))
		).toBe(true);
		const [service] = servicesOf(catalogue);
		if (!service) {
			throw new Error("Missing fixture service");
		}
		// biome-ignore lint/performance/noAwaitInLoops: each attempt must fail before starting a process
		await expect(new Processes(root).start(service)).rejects.toThrow("основн");
	}
	expect(developmentSourceIssue(main, join(main, "apps/web"))).toBeNull();
});

test("a worktree wrapper delegates despite an obsolete launch map, even with managed environment variables", async () => {
	const hub = join(root, "hub");
	mkdirSync(join(hub, "src"), { recursive: true });
	writeFileSync(join(hub, "services.json"), "{}");
	const output = join(root, "wrapper.json");
	writeFileSync(
		join(hub, "src/cli.ts"),
		"await Bun.write(process.env.RESULT_FILE!, JSON.stringify(process.argv.slice(2))); process.exit(7);"
	);
	const child = spawn(
		[process.execPath, join(worktree, ".devhub/launch.cjs"), "apps/web:dev"],
		{
			cwd: worktree,
			env: {
				...process.env,
				DEVHUB_BUN: process.execPath,
				DEVHUB_PROJECT: main,
				DEVHUB_ROOT: hub,
				DEVHUB_SERVICE: "old-demo/obsolete",
				RESULT_FILE: output,
			},
			stderr: "pipe",
			stdout: "pipe",
		}
	);
	expect(await child.exited).toBe(7);
	expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
		"start",
		"--project",
		worktree,
		"--script",
		"apps/web:dev",
	]);
});

test("a canonical project with stage policy refuses dev on another branch and accepts its staging checkout", async () => {
	const policyFile = join(main, ".devhub", "worktree.json");
	expect(developmentSourceIssue(main, join(main, "apps/web"))).toBeNull();
	writeFileSync(policyFile, JSON.stringify({ stageBranch: "stage" }));
	try {
		expect(developmentSourceIssue(main, join(main, "apps/web"))).toContain(
			"ветке stage"
		);
		const catalogue = catalogueSchema.parse({
			projects: [{ ...manifest, path: main }],
		});
		expect(
			catalogueIssues(catalogue).some((issue) => issue.includes("ветке stage"))
		).toBe(true);
		const [service] = servicesOf(catalogue);
		if (!service) {
			throw new Error("Missing staged fixture service");
		}
		await expect(new Processes(root).start(service)).rejects.toThrow(
			"ветке stage"
		);
		git(["switch", "-c", "stage"]);
		expect(developmentSourceIssue(main, join(main, "apps/web"))).toBeNull();
		expect(
			catalogueIssues(catalogue).some((issue) => issue.includes("ветке stage"))
		).toBe(false);
	} finally {
		rmSync(policyFile, { force: true });
		git(["switch", "main"]);
	}
});
