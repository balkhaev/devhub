import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { startHub } from "../src/server";

function git(folder: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", folder, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `Fixture Git failed: ${args[0]}`);
	}
	return result.stdout.trimEnd();
}

async function removeFixture(root: string): Promise<void> {
	const absolute = resolve(root);
	if (
		dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
		!basename(absolute).startsWith("devhub-project-api-")
	) {
		throw new Error(
			`Refuse cleanup outside disposable test fixture: ${absolute}`
		);
	}
	await rm(absolute, { force: true, recursive: true });
}

test("filesystem deletion requires a local authenticated POST and the reviewed token", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-project-api-"));
	const hubRoot = join(root, "hub");
	const app = join(root, "code", "app");
	await mkdir(hubRoot, { recursive: true });
	await mkdir(app, { recursive: true });
	await writeFile(join(app, "local-data.txt"), "keep until explicit delete");
	await writeFile(
		join(hubRoot, "services.json"),
		JSON.stringify({
			code: join(root, "code"),
			projects: [{ id: "app", name: "App", path: app }],
		})
	);
	const instance = await startHub({
		port: 0,
		root: hubRoot,
		runtime: {
			dockerView: async () => ({ available: false, projects: [] }),
			listeningPorts: async () => new Map(),
			listeningPortsV6: async () => new Map(),
		},
	});
	try {
		expect(instance.hub.current.projects[0]).toMatchObject({
			integrationBranch: null,
			mode: null,
			modeEditable: false,
			releaseBranch: null,
		});
		const url = new URL(instance.url);
		const headers = {
			"content-type": "application/json",
			origin: url.origin,
			"x-devhub": "1",
		};
		const planUrl = new URL("api/projects/app/delete-plan", url);
		const deleteUrl = new URL("api/projects/app/delete", url);
		expect((await fetch(deleteUrl)).status).toBe(404);
		expect((await fetch(planUrl, { method: "POST" })).status).toBe(403);
		expect(
			(
				await fetch(planUrl, {
					headers: { ...headers, origin: "https://unrelated.example" },
					method: "POST",
				})
			).status
		).toBe(403);
		const planned = await fetch(planUrl, { headers, method: "POST" });
		expect(planned.status).toBe(200);
		const body = (await planned.json()) as {
			ok: boolean;
			result: { token: string };
		};
		expect(body.ok).toBe(true);
		expect(
			(await fetch(deleteUrl, { body: "{}", headers, method: "POST" })).status
		).toBe(409);
		expect(existsSync(app)).toBe(true);
		const deleted = await fetch(deleteUrl, {
			body: JSON.stringify({ token: body.result.token }),
			headers,
			method: "POST",
		});
		expect(deleted.status).toBe(200);
		expect(existsSync(app)).toBe(false);
		expect(instance.hub.current.projects).toEqual([]);
	} finally {
		instance.stop();
		await removeFixture(root);
	}
});

test("project modes come from the canonical policy and switching requires local authenticated POST", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-project-api-"));
	const hubRoot = join(root, "hub");
	const app = join(root, "code", "app");
	await mkdir(hubRoot, { recursive: true });
	await mkdir(join(app, ".devhub"), { recursive: true });
	git(app, "init", "--initial-branch=main");
	git(app, "config", "user.name", "DevHub fixture");
	git(app, "config", "user.email", "fixture@example.test");
	git(app, "config", "commit.gpgsign", "false");
	git(app, "config", "core.autocrlf", "false");
	await mkdir(join(root, "hooks"));
	git(app, "config", "core.hooksPath", join(root, "hooks"));
	const policyFile = join(app, ".devhub", "worktree.json");
	await writeFile(
		policyFile,
		JSON.stringify({
			checks: ["node check.mjs"],
			releaseBranch: "main",
			stageBranch: "stage",
			version: 1,
			worktreeRoot: "../../worktrees/app",
		})
	);
	await writeFile(join(app, "source.txt"), "initial\n");
	git(app, "add", ".");
	git(app, "commit", "-m", "Initial fixture");
	git(app, "switch", "-c", "stage");
	await writeFile(join(app, "source.txt"), "existing unfinished work\n");
	await writeFile(
		join(hubRoot, "services.json"),
		JSON.stringify({
			code: join(root, "code"),
			projects: [{ id: "app", name: "App", path: app }],
		})
	);
	const instance = await startHub({
		port: 0,
		root: hubRoot,
		runtime: {
			dockerView: async () => ({ available: false, projects: [] }),
			listeningPorts: async () => new Map(),
			listeningPortsV6: async () => new Map(),
		},
	});
	try {
		const previous = await readFile(policyFile, "utf8");
		expect(instance.hub.current.projects[0]?.mode).toBe("prod");
		expect(instance.hub.current.projects[0]?.integrationBranch).toBe("stage");
		const endpoint = new URL("api/projects/app/mode", instance.url);
		const headers = {
			"content-type": "application/json",
			origin: new URL(instance.url).origin,
			"x-devhub": "1",
		};
		const body = JSON.stringify({ mode: "mvp" });
		expect((await fetch(endpoint)).status).toBe(404);
		expect((await fetch(endpoint, { body, method: "POST" })).status).toBe(403);
		expect(
			(
				await fetch(endpoint, {
					body,
					headers: { ...headers, origin: "https://unrelated.example" },
					method: "POST",
				})
			).status
		).toBe(403);
		const invalidResponses = await Promise.all(
			["{}", '{"mode":"preview"}', "null"].map((invalid) =>
				fetch(endpoint, { body: invalid, headers, method: "POST" })
			)
		);
		for (const response of invalidResponses) {
			expect(response.status).toBe(409);
		}
		expect(await readFile(policyFile, "utf8")).toBe(previous);
		const changed = await fetch(endpoint, { body, headers, method: "POST" });
		expect(changed.status).toBe(200);
		expect((await changed.json()).result).toEqual({
			integrationBranch: "main",
			mode: "mvp",
			releaseBranch: "main",
		});
		expect(instance.hub.current.projects[0]).toMatchObject({
			currentBranch: "main",
			integrationBranch: "main",
			mode: "mvp",
			modeEditable: true,
		});
		expect(JSON.parse(await readFile(policyFile, "utf8")).mode).toBe("mvp");
		expect(await readFile(join(app, "source.txt"), "utf8")).toBe(
			"existing unfinished work\n"
		);
		const restored = await fetch(endpoint, {
			body: JSON.stringify({ mode: "prod" }),
			headers,
			method: "POST",
		});
		expect(restored.status).toBe(200);
		expect(instance.hub.current.projects[0]).toMatchObject({
			currentBranch: "stage",
			integrationBranch: "stage",
			mode: "prod",
		});
		expect(await readFile(join(app, "source.txt"), "utf8")).toBe(
			"existing unfinished work\n"
		);
	} finally {
		instance.stop();
		await removeFixture(root);
	}
});
