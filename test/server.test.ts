import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { sleep } from "bun";

import { type Catalogue, catalogueSchema, type Service } from "../src/config";
import { type Managed, Processes } from "../src/processes";
import { Queue } from "../src/queue";
import { startHub, actionWords as words } from "../src/server";

const FIXTURE_PREFIX = "devhub-server-test-";

test("an action's address is said in words for the journal", () => {
	expect(words("/api/docker/gameradar/stop")).toBe(
		"Docker gameradar: остановить"
	);
	expect(words("/api/projects/montage/start")).toBe(
		"проект montage: запустить"
	);
	expect(words("/api/services/altay/site/restart")).toBe(
		"altay/site: перезапустить"
	);
	expect(words("/api/queue/stop")).toBe("очередь: остановить");
	expect(words("/api/queue/pause")).toBe("очередь: пауза");
	expect(words("/api/queue/resume")).toBe("очередь: снять паузу");
	expect(words("/api/queue/continue")).toBe("очередь: продолжить");
	expect(words("/api/queue/executors/modeler/enable")).toBe(
		"исполнитель modeler: включить приём"
	);
	expect(words("/api/queue/executors/modeler/pause")).toBe(
		"исполнитель modeler: пауза"
	);
	expect(words("/api/queue/executors/modeler/stop")).toBe(
		"исполнитель modeler: остановить"
	);
	expect(words("/api/queue/executors/modeler/accept-on")).toBe(
		"исполнитель modeler: принимать заказы при запуске"
	);
	expect(words("/api/queue/executors/modeler/accept-off")).toBe(
		"исполнитель modeler: не принимать заказы при запуске"
	);
});

async function fixtureRoot() {
	const root = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
	return {
		async close() {
			const absolute = resolve(root);
			if (
				dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
				!basename(absolute).startsWith(FIXTURE_PREFIX)
			) {
				throw new Error(`Refuse cleanup outside server fixture: ${absolute}`);
			}
			await rm(absolute, { force: true, recursive: true });
		},
		root,
	};
}

const quietComputer = {
	dockerView: async () => ({ available: false, projects: [] }),
	listeningPorts: async () => new Map<number, number>(),
	listeningPortsV6: async () => new Map<number, number>(),
};

/** The journal is written behind the answer: wait for a line rather than for a moment. */
async function journalLine(root: string, wanted: string): Promise<string> {
	const file = join(root, ".logs", "actions.log");
	for (let attempt = 0; attempt < 200; attempt += 1) {
		// biome-ignore lint/performance/noAwaitInLoops: polling a file another task appends to
		const text = await readFile(file, "utf8").catch(() => "");
		const line = text.split("\n").find((entry) => entry.includes(wanted));
		if (line) {
			return line;
		}
		await sleep(10);
	}
	throw new Error(`the journal never said: ${wanted}`);
}

const queueCatalogue = (): Catalogue =>
	catalogueSchema.parse({
		projects: [
			{
				id: "inference",
				name: "Inference",
				path: "F:/fixture/inference",
				services: [
					{
						id: "queue",
						name: "Queue",
						port: 8765,
						queue: { role: "queue", tokenFile: "runtime/api-token" },
					},
					{
						id: "executors",
						name: "Executors",
						port: 8766,
						queue: { role: "executors", tokenFile: "runtime/api-token" },
					},
				],
			},
		],
	});

test("the queue's state and commands go through the hub for its page and its tray only", async () => {
	const sample = await fixtureRoot();
	const catalogue = queueCatalogue();
	const upstream: { body: string | null; method: string; url: string }[] = [];
	const queue = new Queue(() => catalogue, {
		fetch: (url, init) => {
			const method = init.method ?? "GET";
			upstream.push({
				body: typeof init.body === "string" ? init.body : null,
				method,
				url,
			});
			if (url.endsWith("/api/status")) {
				return Promise.resolve(
					Response.json({
						active_count: 1,
						active_jobs: [
							{
								id: "job-1",
								name: "Render",
								spec: { command: "hidden", resource: "gpu" },
								started: 1_760_000_000,
							},
						],
						paused: false,
						stopped: false,
					})
				);
			}
			if (url.endsWith("/api/executors")) {
				return Promise.resolve(
					Response.json([
						{
							accept_on_start: { enabled: true, text: "Modeler: при запуске" },
							commands: [
								{
									enabled: true,
									id: "pause",
									short: "Пауза",
									text: "Modeler: пауза",
								},
							],
							id: "modeler",
							label: "Принимает заказы",
							name: "Modeler",
							note: "",
							paired: true,
						},
					])
				);
			}
			if (url.endsWith("/api/queue/stop")) {
				return Promise.resolve(
					Response.json({ detail: "Очередь уже остановлена" }, { status: 409 })
				);
			}
			return Promise.resolve(Response.json({ ok: true }));
		},
		freshMs: 0,
		readFile: () => Promise.resolve("queue-token"),
	});
	const instance = await startHub({
		catalogue,
		port: 0,
		queue,
		root: sample.root,
		runtime: quietComputer,
	});
	try {
		const url = new URL(instance.url);
		const page = { origin: url.origin, "x-devhub": "1" };
		const tray = {
			"x-devhub-client": (
				await readFile(join(sample.root, ".state", "client-token"), "utf8")
			).trim(),
		};
		const state = new URL("api/queue", url);
		expect((await fetch(state)).status).toBe(403);
		expect(
			(
				await fetch(state, {
					headers: { ...page, origin: "https://unrelated.example" },
				})
			).status
		).toBe(403);
		expect(upstream).toEqual([]);
		const seen = (await (await fetch(state, { headers: page })).json()) as {
			queue: Record<string, unknown>;
		};
		expect(seen.queue).toMatchObject({
			executorsService: "inference/executors",
			jobs: [
				{
					id: "job-1",
					name: "Render",
					private: false,
					resource: "gpu",
					startedAt: 1_760_000_000_000,
				},
			],
			label: "Выполняется: 1",
			panel: "#/inference/queue",
			service: "inference/queue",
			state: "working",
		});
		expect(JSON.stringify(seen)).not.toContain("hidden");
		expect(JSON.stringify(seen)).not.toContain("queue-token");

		const menuUrl = new URL("api/queue/tray", url);
		expect((await fetch(menuUrl)).status).toBe(403);
		const menu = (await (await fetch(menuUrl, { headers: tray })).json()) as {
			items: { open?: string; post?: string; text?: string }[];
			tip: string;
		};
		expect(menu.tip).toBe("очередь: выполняется 1");
		expect(menu.items.map((entry) => entry.text ?? "—")).toEqual([
			"Общая очередь · Выполняется: 1",
			"Открыть общую очередь",
			"Стоп общей очереди",
			"Пауза общей очереди",
			"Продолжить общую очередь",
			"—",
			"Modeler · Принимает заказы",
			"Modeler: пауза",
			"Modeler: при запуске",
		]);
		expect(menu.items[1]?.open).toBe(`${url.origin}/#/inference/queue`);

		upstream.length = 0;
		const send = (path: string, headers: Record<string, string>) =>
			fetch(new URL(path, url), { headers, method: "POST" });
		expect((await send("api/queue/pause", {})).status).toBe(403);
		expect(
			(
				await send("api/queue/pause", {
					...page,
					origin: "https://evil.example",
				})
			).status
		).toBe(403);
		expect(upstream).toEqual([]);

		const paused = await send("api/queue/pause", tray);
		expect(paused.status).toBe(200);
		expect(await paused.json()).toEqual({ ok: true, result: null });
		const resumed = await send("api/queue/resume", page);
		expect(resumed.status).toBe(200);
		expect((await send("api/queue/continue", tray)).status).toBe(200);

		const refused = await send("api/queue/stop", tray);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({
			error: "Очередь уже остановлена",
			ok: false,
		});
		const unknown = await send("api/queue/restart", page);
		expect(unknown.status).toBe(409);
		expect(((await unknown.json()) as { error: string }).error).toBe(
			"неизвестное действие restart"
		);

		expect((await send("api/queue/executors/modeler/pause", tray)).status).toBe(
			200
		);
		expect(
			(await send("api/queue/executors/modeler/accept-off", page)).status
		).toBe(200);
		expect(
			(await send("api/queue/executors/modeler/remove", page)).status
		).toBe(409);
		expect(
			upstream.map(
				(call) =>
					`${call.method} ${call.url.slice("http://127.0.0.1:".length)}${call.body ? ` ${call.body}` : ""}`
			)
		).toEqual([
			"POST 8765/api/pause",
			"POST 8765/api/resume",
			"POST 8765/api/queue/continue",
			"POST 8765/api/queue/stop",
			"POST 8766/api/executors/modeler/pause",
			'POST 8766/api/executors/modeler/accept-on-start {"enabled":false}',
		]);
		expect(await journalLine(sample.root, "очередь: пауза")).toContain(
			"очередь: пауза — готово"
		);
		expect(await journalLine(sample.root, "очередь: остановить")).toContain(
			"очередь: остановить — не вышло: Очередь уже остановлена"
		);
		expect(
			await journalLine(sample.root, "исполнитель modeler: не принимать")
		).toContain("— готово");
	} finally {
		instance.stop();
		await sample.close();
	}
});

test("a hub without a declared queue shows none and has nothing for the tray", async () => {
	const sample = await fixtureRoot();
	const instance = await startHub({
		catalogue: catalogueSchema.parse({ projects: [] }),
		port: 0,
		root: sample.root,
		runtime: quietComputer,
	});
	try {
		const url = new URL(instance.url);
		const page = { origin: url.origin, "x-devhub": "1" };
		const state = await fetch(new URL("api/queue", url), { headers: page });
		expect(await state.json()).toEqual({ queue: null });
		const menu = await fetch(new URL("api/queue/tray", url), { headers: page });
		expect(await menu.json()).toEqual({ items: [], tip: "" });
		const stop = await fetch(new URL("api/queue/stop", url), {
			headers: page,
			method: "POST",
		});
		expect(stop.status).toBe(409);
	} finally {
		instance.stop();
		await sample.close();
	}
});

class RecordingProcesses extends Processes {
	readonly entries = new Map<string, Managed>();
	readonly launches: string[] = [];

	override async adopt(): Promise<void> {
		await Promise.resolve();
	}

	override get(key: string): Managed | undefined {
		return this.entries.get(key);
	}

	override sweep(): boolean {
		return false;
	}

	override async start(service: Service): Promise<Managed> {
		this.launches.push(service.key);
		const entry: Managed = {
			command: service.command ?? "",
			cwd: service.workdir,
			exit: null,
			log: "test.log",
			pid: process.pid,
			startedAt: Date.now(),
			stopping: false,
		};
		this.entries.set(service.key, entry);
		await Promise.resolve();
		return entry;
	}
}

test("services marked autostart come up with the hub, without holding its readiness back", async () => {
	const sample = await fixtureRoot();
	const processes = new RecordingProcesses(sample.root);
	const instance = await startHub({
		catalogue: catalogueSchema.parse({
			projects: [
				{
					id: "app",
					name: "App",
					path: sample.root,
					services: [
						{ command: "run-manual", id: "manual", name: "Manual" },
						{
							autostart: true,
							command: "run-worker",
							id: "worker",
							name: "Worker",
						},
						{
							autostart: true,
							command: "run-held",
							id: "held",
							name: "Held",
							port: 8765,
						},
					],
				},
			],
		}),
		port: 0,
		root: sample.root,
		runtime: {
			...quietComputer,
			listeningPorts: async () => new Map([[8765, process.pid + 999_999]]),
			noPortWarmupMs: 1,
			processes,
			processInfo: async (pids) =>
				new Map(
					pids.map((pid) => [
						pid,
						{ command: "", name: "python.exe", parent: 0, pid },
					])
				),
			startPollMs: 1,
		},
	});
	try {
		const health = await fetch(new URL("api/health", instance.url));
		expect(health.status).toBe(200);
		const line = await journalLine(sample.root, "автозапуск");
		expect(line).toContain(
			"автозапуск (app/worker, app/held) — не всё: Held: порт 8765 занят"
		);
		expect(processes.launches).toEqual(["app/worker"]);
	} finally {
		instance.stop();
		await sample.close();
	}
});
