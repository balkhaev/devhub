import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHub } from "../src/server";

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
		await rm(root, { force: true, recursive: true });
	}
});
