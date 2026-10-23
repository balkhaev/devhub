import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { ProjectKnowledge } from "../src/knowledge-schema";
import { startHub } from "../src/server";

async function cleanup(folder: string) {
	const target = resolve(folder);
	if (
		dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
		!basename(target).startsWith("devhub-knowledge-api-")
	) {
		throw new Error("Unsafe fixture path");
	}
	await rm(target, { force: true, recursive: true });
}

test("knowledge API authenticates every read/write, keeps concurrent edits and survives hub restart", async () => {
	const folder = await mkdtemp(join(tmpdir(), "devhub-knowledge-api-"));
	const app = join(folder, "app");
	await mkdir(app);
	await writeFile(
		join(folder, "services.json"),
		JSON.stringify({ projects: [{ id: "app", name: "App", path: app }] })
	);
	const options = {
		knowledgeFile: join(folder, "knowledge.sqlite"),
		port: 0,
		root: folder,
		runtime: {
			dockerView: () => Promise.resolve({ available: false, projects: [] }),
			listeningPorts: () => Promise.resolve(new Map<number, number>()),
			listeningPortsV6: () => Promise.resolve(new Map<number, number>()),
		},
	};
	let instance = await startHub(options);
	try {
		const endpoint = `${instance.url}api/knowledge/app`;
		const headers = {
			"content-type": "application/json",
			origin: new URL(instance.url).origin,
			"x-devhub": "1",
		};
		const token = (
			await readFile(join(folder, ".state/client-token"), "utf8")
		).trim();
		expect((await fetch(endpoint)).status).toBe(403);
		expect((await fetch(endpoint, { body: "{}", method: "POST" })).status).toBe(
			403
		);
		expect(
			(
				await fetch(endpoint, {
					headers: {
						...headers,
						origin: "https://hostile.test",
						"x-devhub-client": token,
					},
				})
			).status
		).toBe(403);
		expect(
			(await fetch(endpoint, { headers: { "x-devhub-client": token } })).status
		).toBe(200);
		expect(
			(await fetch(endpoint, { headers: { ...headers, host: "hostile.test" } }))
				.status
		).toBe(403);
		expect(
			(await fetch(`${instance.url}api/knowledge/missing`, { headers })).status
		).toBe(404);
		expect(
			(await fetch(endpoint, { body: "invalid json", headers, method: "POST" }))
				.status
		).toBe(400);
		const body = JSON.stringify({
			operations: [
				{
					card: {
						columnId: "backlog",
						id: "task",
						labels: ["решение"],
						text: "ссылка на исследование",
						title: "План",
					},
					type: "kanban.card.put",
				},
			],
			revision: 0,
		});
		const writes = await Promise.all([
			fetch(endpoint, { body, headers, method: "POST" }),
			fetch(endpoint, { body, headers, method: "POST" }),
		]);
		expect(writes.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
		const saved = (await (
			await fetch(endpoint, { headers })
		).json()) as ProjectKnowledge;
		expect(saved.revision).toBe(1);
		expect(saved.kanban.cards).toHaveLength(1);
		expect((await fetch(`${endpoint}?q=`, { headers })).status).toBe(400);
		const hits = await (
			await fetch(`${endpoint}?q=${encodeURIComponent("ИССЛЕДОВАНИЕ")}`, {
				headers,
			})
		).json();
		expect(hits).toMatchObject({ hits: [{ id: "task", kind: "kanban" }] });
		instance.stop();
		instance = await startHub(options);
		const restored = await (
			await fetch(`${instance.url}api/knowledge/app`, {
				headers: { "x-devhub-client": token },
			})
		).json();
		expect(restored).toEqual(saved);
	} finally {
		instance.stop();
		await cleanup(folder);
	}
});
