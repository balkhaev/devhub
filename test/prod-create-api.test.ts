import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Coolify } from "../src/coolify";
import { ProjectCreator } from "../src/create";
import { startHub } from "../src/server";

test("production state and project creation answer only the hub's page and CLI", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-prod-api-"));
	const hubRoot = join(root, "hub");
	const code = join(root, "code");
	await mkdir(hubRoot, { recursive: true });
	await mkdir(code, { recursive: true });
	await writeFile(
		join(hubRoot, "services.json"),
		JSON.stringify({
			code,
			coolify: { url: "https://deploy.example.com" },
			discover: [code],
			projects: [],
		})
	);
	let hubConfiguration: () => import("../src/config").Catalogue = () => {
		throw new Error("not started");
	};
	const coolify = new Coolify(() => hubConfiguration(), {
		fetch: (input) => {
			const path = new URL(input).pathname.replace("/api/v1", "");
			const body =
				path === "/applications"
					? [{ name: "site", status: "running:healthy", uuid: "app-1" }]
					: [];
			return Promise.resolve(Response.json(body));
		},
		token: () => "token",
	});
	const creator = new ProjectCreator({
		catalogue: () => hubConfiguration(),
		hubRoot,
		registered: () => Promise.resolve(),
		runner: () => Promise.resolve(0),
	});
	const instance = await startHub({
		coolify,
		creator,
		port: 0,
		root: hubRoot,
		runtime: {
			dockerView: async () => ({ available: false, projects: [] }),
			listeningPorts: async () => new Map(),
			listeningPortsV6: async () => new Map(),
		},
	});
	hubConfiguration = () => instance.hub.configuration;
	try {
		const url = new URL(instance.url);
		const page = { origin: url.origin, "x-devhub": "1" };
		const prod = new URL("api/prod", url);
		expect((await fetch(prod)).status).toBe(403);
		expect(
			(
				await fetch(prod, {
					headers: { ...page, origin: "https://evil.example" },
				})
			).status
		).toBe(403);
		const view = (await (await fetch(prod, { headers: page })).json()) as {
			unmatched: { name: string }[];
		};
		expect(view.unmatched.map((app) => app.name)).toEqual(["site"]);
		const token = (
			await readFile(join(hubRoot, ".state", "client-token"), "utf8")
		).trim();
		const cli = { "x-devhub-client": token };
		expect((await fetch(prod, { headers: cli })).status).toBe(200);
		expect(
			(
				await fetch(new URL("api/prod/apps/unknown/logs", url), {
					headers: page,
				})
			).status
		).toBe(404);

		const create = new URL("api/create", url);
		const body = JSON.stringify({
			name: "notes",
			template: "python",
			web: false,
		});
		expect(
			(
				await fetch(create, {
					body,
					headers: { "content-type": "application/json" },
					method: "POST",
				})
			).status
		).toBe(403);
		const started = (await (
			await fetch(create, {
				body,
				headers: { ...page, "content-type": "application/json" },
				method: "POST",
			})
		).json()) as { ok: boolean; result: { id: string } };
		expect(started.ok).toBe(true);
		const invalid = await fetch(create, {
			body: JSON.stringify({ name: "Bad Name", template: "python" }),
			headers: { ...page, "content-type": "application/json" },
			method: "POST",
		});
		expect(invalid.status).toBe(409);
		const job = new URL(`api/create/${started.result.id}`, url);
		expect((await fetch(job)).status).toBe(403);
		expect((await fetch(job, { headers: cli })).status).toBe(200);
	} finally {
		instance.stop();
		await rm(root, { force: true, recursive: true });
	}
});
