import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { type Catalogue, catalogueSchema } from "../src/config";
import {
	Queue,
	type QueueView,
	queueView,
	type TrayItem,
	trayMenu,
} from "../src/queue";

const PROJECT = "F:/fixture/inference";
const TOKEN_FILE = resolve(PROJECT, "runtime/api-token");
const HUB = "http://127.0.0.1:4700";
const SERVICES = { executors: "inference/executors", queue: "inference/queue" };
const JOB = "8ee7c920-a582-4ba9-90fc-926dc4a7c865";

const catalogue = (services: unknown[]): Catalogue =>
	catalogueSchema.parse({
		projects: [{ id: "inference", name: "Inference", path: PROJECT, services }],
	});

const queueService = (extra: Record<string, unknown> = {}) => ({
	id: "queue",
	name: "Queue",
	port: 8765,
	queue: { role: "queue", tokenFile: "runtime/api-token" },
	...extra,
});
const executorsService = {
	id: "executors",
	name: "Executors",
	port: 8766,
	queue: { role: "executors", tokenFile: "runtime/api-token" },
};

const status = (changes: Record<string, unknown> = {}) => ({
	active_count: 0,
	active_jobs: [],
	gpu: {
		free_mb: 12_000,
		name: "RTX 5080",
		temperature: 61,
		total_mb: 16_000,
		utilization: 12.4,
	},
	host: { available_mb: 40_000, cpu_utilization: 7.5, total_mb: 64_000 },
	paused: false,
	queued_count: 0,
	stopped: false,
	waiting_for: [],
	...changes,
});

const modeler = (changes: Record<string, unknown> = {}) => ({
	accept_on_start: {
		enabled: true,
		text: "Modeler: принимать заказы при запуске",
	},
	accepting: false,
	attached: true,
	busy: false,
	commands: [
		{
			enabled: true,
			id: "enable",
			short: "Принимать",
			text: "Modeler: принимать заказы",
		},
		{
			enabled: false,
			id: "pause",
			short: "Пауза",
			text: "Modeler: пауза после текущего заказа",
		},
		{ enabled: false, id: "stop", short: "Стоп", text: "Modeler: остановить" },
	],
	connected: true,
	error: "",
	id: "modeler",
	label: "На паузе · приём выключен",
	name: "Modeler",
	note: "Последний заказ выполнен",
	paired: true,
	site: "https://modeler.example.test",
	...changes,
});

/** A queue whose two services answer from a table of `METHOD path` → response. */
function fixture(
	answers: Record<string, () => Response>,
	options: { services?: unknown[]; token?: string | null } = {}
) {
	const calls: {
		authorization: string | null;
		body: string | null;
		method: string;
		url: string;
	}[] = [];
	const reads: string[] = [];
	const queue = new Queue(
		() => catalogue(options.services ?? [queueService(), executorsService]),
		{
			fetch: (url, init) => {
				const method = init.method ?? "GET";
				calls.push({
					authorization: new Headers(init.headers).get("authorization"),
					body: typeof init.body === "string" ? init.body : null,
					method,
					url,
				});
				const answer =
					answers[`${method} ${new URL(url).port}${new URL(url).pathname}`];
				return answer
					? Promise.resolve(answer())
					: Promise.reject(new Error("connection refused"));
			},
			freshMs: 0,
			readFile: (path) => {
				reads.push(path);
				return options.token === null
					? Promise.reject(new Error("ENOENT"))
					: Promise.resolve(`${options.token ?? "secret-token"}\n`);
			},
		}
	);
	return { calls, queue, reads };
}

const texts = (items: TrayItem[]): string[] =>
	items.map((entry) => ("separator" in entry ? "—" : entry.text));
test("job metadata omits runtime payloads and keeps private names hidden", () => {
	const view = queueView(
		SERVICES,
		status({
			active_count: 2,
			active_jobs: [
				{
					command: ["blender", "--secret-scene"],
					error: "private failure",
					id: "job-1",
					name: "Render shot 12",
					result: { path: "C:/private/out.png" },
					spec: { command: "blender", resource: "gpu", workflow: { a: 1 } },
					started: 1_760_000_000.4,
				},
				{
					id: "job-2",
					name: "A private prompt that must not be shown",
					private: true,
					spec: { resource: "cpu" },
				},
				{ name: "no id" },
				"not a job",
			],
			queued_count: 3,
			waiting_for: ["Видеопамять занята: нужно 9 ГБ", "", 7],
		}),
		null
	);
	expect(view.jobs).toEqual([
		{
			id: "job-1",
			name: "Render shot 12",
			private: false,
			resource: "gpu",
			startedAt: 1_760_000_000_400,
		},
		{
			id: "job-2",
			name: "Анонимное задание",
			private: true,
			resource: "cpu",
			startedAt: null,
		},
	]);
	const sent = JSON.stringify(view);
	for (const secret of [
		"blender",
		"private failure",
		"private prompt",
		"workflow",
		"out.png",
	]) {
		expect(sent).not.toContain(secret);
	}
	expect(view).toMatchObject({
		executors: null,
		executorsService: "inference/executors",
		gpu: {
			name: "RTX 5080",
			temperature: 61,
			totalMb: 16_000,
			usedMb: 4000,
			utilization: 12.4,
		},
		host: { availableMb: 40_000, cpu: 7.5, totalMb: 64_000 },
		label: "Выполняется: 2 · GPU 12%",
		panel: "#/inference/queue",
		queued: 3,
		running: 2,
		service: "inference/queue",
		state: "working",
		waitingFor: ["Видеопамять занята: нужно 9 ГБ"],
	});
});

test("generation progress retains measured counters and rebuilds private phase labels", () => {
	const view = queueView(
		SERVICES,
		status({
			active_jobs: [
				{
					id: JOB,
					name: "private prompt",
					private: true,
					progress: {
						node: "private node",
						path: "private path",
						percent: 50,
						phase: "sampling",
						phase_title: "private worker text",
						scope: "node",
						step: 4,
						total_steps: 8,
						updated_at: 1_790_000_000,
					},
					spec: { resource: "gpu" },
				},
			],
		}),
		null
	);
	expect(view.jobs[0]).toEqual({
		id: JOB,
		name: "Анонимное задание",
		private: true,
		progress: {
			percent: 50,
			phase: "sampling",
			phaseTitle: "Генерация",
			scope: "node",
			step: 4,
			totalSteps: 8,
			updatedAt: 1_790_000_000_000,
		},
		resource: "gpu",
		startedAt: null,
	});
	expect(JSON.stringify(view)).not.toContain("private prompt");
	expect(JSON.stringify(view)).not.toContain("private worker");
	expect(JSON.stringify(view)).not.toContain("private node");
	expect(JSON.stringify(view)).not.toContain("private path");
});

test.each(
	[
		0,
		1,
		100,
		null,
		true,
		"50",
		[],
		{},
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
		101,
	].map((percent) => ({ percent }))
)(
	"progress validates finite percentages without estimating unknown values: %p",
	({ percent }) => {
		const view = queueView(
			SERVICES,
			status({
				active_jobs: [
					{
						id: JOB,
						progress: {
							percent,
							phase: "private path",
							phase_title: "private text",
							scope: "node",
							step: 0,
							total_steps: 8,
							updated_at: Number.MAX_VALUE,
						},
					},
				],
			}),
			null
		);
		const progress = view.jobs[0]?.progress;
		expect(progress).toEqual({
			percent:
				typeof percent === "number" &&
				Number.isFinite(percent) &&
				percent >= 0 &&
				percent <= 100
					? percent
					: null,
			phase: "running",
			phaseTitle: "Выполняется",
			scope: "node",
			step: 0,
			totalSteps: 8,
			updatedAt: null,
		});
	}
);

test("malformed scopes and counters stay indeterminate without forwarding raw values", () => {
	const view = queueView(
		SERVICES,
		status({
			active_jobs: [
				{
					id: JOB,
					progress: {
						percent: 40,
						phase: "sampling",
						scope: ["private text"],
						step: 10,
						total_steps: 8,
						updated_at: -1,
					},
				},
			],
		}),
		null
	);
	expect(view.jobs[0]?.progress).toEqual({
		percent: null,
		phase: "sampling",
		phaseTitle: "Генерация",
		scope: "stage",
		step: null,
		totalSteps: null,
		updatedAt: null,
	});
});

test("selected diagnostics include the same safe progress contract without fetching private data", async () => {
	const { queue, calls } = fixture({
		[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
			Response.json({
				job: {
					id: JOB,
					progress: {
						percent: null,
						phase: "decode",
						phase_title: "private text",
						scope: "stage",
						step: null,
						total_steps: null,
					},
					state: "running",
				},
			}),
	});
	expect((await queue.job(JOB)).progress).toEqual({
		percent: null,
		phase: "decode",
		phaseTitle: "Декодирование",
		scope: "stage",
		step: null,
		totalSteps: null,
		updatedAt: null,
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toEndWith(`/api/jobs/${JOB}/diagnostics`);
});

test("waiting jobs keep the scheduler's order and privacy without duplicating active or launched jobs", () => {
	const view = queueView(
		SERVICES,
		status({
			active_jobs: [{ id: "active", name: "Running" }],
			queued_count: 5,
		}),
		null,
		{
			jobs: [
				{
					command: ["private-command"],
					estimate: { resource: "gpu", workflow: "private-workflow" },
					job_id: "waiting-1",
					name: "Next render",
					started: 123,
					waiting_for: ["private-path"],
				},
				{
					estimate: { resource: "cpu" },
					job_id: "waiting-private",
					name: "Secret job name",
					private: true,
				},
				{
					estimate: { resource: "gpu" },
					job_id: "waiting-anonymous",
					name: "Анонимное задание",
				},
				{ job_id: "launched", launched: true, name: "Just started" },
				{ job_id: "active", name: "Already running" },
				{ job_id: "waiting-1", name: "Duplicate" },
				{ name: "Missing id" },
				"not a job",
			],
		}
	);
	expect(view.queued).toBe(5);
	expect(view.queuedJobs).toEqual([
		{
			id: "waiting-1",
			name: "Next render",
			private: false,
			resource: "gpu",
			startedAt: null,
		},
		{
			id: "waiting-private",
			name: "Анонимное задание",
			private: true,
			resource: "cpu",
			startedAt: null,
		},
		{
			id: "waiting-anonymous",
			name: "Анонимное задание",
			private: true,
			resource: "gpu",
			startedAt: null,
		},
	]);
	for (const secret of [
		"private-command",
		"private-workflow",
		"private-path",
		"Secret job name",
	]) {
		expect(JSON.stringify(view)).not.toContain(secret);
	}
});

test("waiting listings distinguish unavailable data from an empty queue and never outlive an offline status", () => {
	const plan = { jobs: [{ job_id: "old-job", name: "Old plan" }] };
	expect(queueView(SERVICES, status(), null, plan).queuedJobs).toEqual([]);
	expect(queueView(SERVICES, null, null, plan).queuedJobs).toBeNull();
	expect(
		queueView(SERVICES, status({ queued_count: 2 }), null).queuedJobs
	).toBeNull();
	expect(
		queueView(SERVICES, status({ queued_count: 2 }), null, {
			jobs: "not a list",
		}).queuedJobs
	).toBeNull();
	expect(
		queueView(SERVICES, status({ queued_count: 2 }), null, { jobs: [] })
			.queuedJobs
	).toEqual([]);
});

test("the queue's state is said in words; the owner's stop wins over a pause and silence is offline", () => {
	const of = (answer: unknown): Pick<QueueView, "label" | "state"> => {
		const { label, state } = queueView(SERVICES, answer, null);
		return { label, state };
	};
	expect(of(status())).toEqual({
		label: "Общая очередь готова · GPU 12%",
		state: "ready",
	});
	expect(of(status({ gpu: null, paused: true }))).toEqual({
		label: "Очередь на паузе",
		state: "paused",
	});
	expect(of(status({ paused: true, stopped: true }))).toEqual({
		label: "Очередь остановлена · GPU 12%",
		state: "stopped",
	});
	// The count is the queue's own; without it, or with a smaller one, the listed jobs are counted.
	expect(of(status({ active_count: 3 }))).toEqual({
		label: "Выполняется: 3 · GPU 12%",
		state: "working",
	});
	expect(
		of(
			status({ active_count: undefined, active_jobs: [{ id: "a", name: "a" }] })
		)
	).toEqual({ label: "Выполняется: 1 · GPU 12%", state: "working" });
	expect(of(null)).toEqual({ label: "Нет связи с очередью", state: "offline" });
	expect(of("<html>")).toEqual({
		label: "Нет связи с очередью",
		state: "offline",
	});
	// An older running queue says less: what is missing is unknown, not zero.
	const old = queueView(SERVICES, { paused: false, stopped: false }, null);
	expect(old).toMatchObject({
		gpu: null,
		host: null,
		jobs: [],
		label: "Общая очередь готова",
		queued: null,
		state: "ready",
		waitingFor: [],
	});
});

test("the tray menu keeps the owner's wording and offers only what the queue's state allows", () => {
	const menu = (answer: unknown) =>
		trayMenu(queueView(SERVICES, answer, null), HUB);
	const ready = menu(status());
	expect(texts(ready.items)).toEqual([
		"Общая очередь готова · GPU 12%",
		"Открыть общую очередь",
		"Стоп общей очереди",
		"Пауза общей очереди",
		"Продолжить общую очередь",
	]);
	expect(ready.tip).toBe("очередь: готова · GPU 12%");
	expect(ready.items[0]).toEqual({
		enabled: false,
		text: "Общая очередь готова · GPU 12%",
	});
	expect(ready.items[1]).toEqual({
		enabled: true,
		open: "http://127.0.0.1:4700/#/inference/queue",
		text: "Открыть общую очередь",
	});
	const enabled = (answer: unknown) =>
		menu(answer)
			.items.slice(2)
			.map((entry) => "enabled" in entry && entry.enabled);
	expect(ready.items.slice(2)).toEqual([
		{ enabled: true, post: "/api/queue/stop", text: "Стоп общей очереди" },
		{ enabled: true, post: "/api/queue/pause", text: "Пауза общей очереди" },
		{
			enabled: false,
			post: "/api/queue/continue",
			text: "Продолжить общую очередь",
		},
	]);
	expect(enabled(status({ paused: true }))).toEqual([true, false, true]);
	expect(enabled(status({ stopped: true }))).toEqual([false, false, true]);
	expect(enabled(null)).toEqual([false, false, false]);

	const working = menu(
		status({ active_count: 2, gpu: { ...status().gpu, utilization: 87 } })
	);
	expect(texts(working.items)[0]).toBe(
		"Общая очередь · Выполняется: 2 · GPU 87%"
	);
	expect(working.tip).toBe("очередь: выполняется 2 · GPU 87%");
	expect(texts(menu(status({ gpu: null, paused: true })).items)[0]).toBe(
		"Очередь на паузе"
	);
	expect(menu(status({ gpu: null, stopped: true })).tip).toBe(
		"очередь: остановлена"
	);
	const offline = menu(null);
	expect(texts(offline.items)[0]).toBe("Нет связи с очередью");
	expect(offline.tip).toBe("очередь: нет связи");
	expect(trayMenu(null, HUB)).toEqual({ items: [], tip: "" });
});

test("the tray omits every executor section, command and switch while the page keeps them", () => {
	const view = queueView(SERVICES, status(), [
		modeler(),
		modeler({ id: "unpaired", name: "Unpaired", paired: false }),
		modeler({
			accept_on_start: {
				enabled: false,
				text: "Montage: принимать заказы при запуске",
			},
			commands: [],
			id: "montage",
			label: "Принимает заказы",
			name: "Montage",
			note: "",
		}),
		modeler({ id: "../escape" }),
	]);
	expect(view.executors?.map((executor) => executor.id)).toEqual([
		"modeler",
		"unpaired",
		"montage",
	]);
	const menu = trayMenu(view, HUB);
	expect(menu.items).toEqual(
		trayMenu(queueView(SERVICES, status(), null), HUB).items
	);
	expect(menu.items).toHaveLength(5);
	for (const word of [
		"modeler",
		"Modeler",
		"Montage",
		"executors",
		"accept-",
	]) {
		expect(JSON.stringify(menu)).not.toContain(word);
	}
});

test("tray hover observations retain the widget's safe per-job progress and load", () => {
	const view = queueView(
		SERVICES,
		status({
			active_jobs: [
				{
					command: "private command",
					id: JOB,
					name: "private prompt",
					private: true,
					progress: {
						percent: 37.5,
						phase: "sampling",
						phase_title: "private worker text",
						scope: "node",
						step: 3,
						total_steps: 8,
						updated_at: 1_790_000_000,
					},
					spec: { resource: "gpu", workflow: "private workflow" },
					started: 1_790_000_000,
				},
			],
			queued_count: 4,
		}),
		[modeler()]
	);
	// Re-assert anonymity in the tray projection even if another consumer changes a public row.
	const [job] = view.jobs;
	if (!job) {
		throw new Error("missing active job");
	}
	job.name = "private renamed title";
	const menu = trayMenu(view, HUB);
	expect(menu.tip).toBe("очередь: Генерация · 37,5% операции · 3/8");
	expect(menu.status).toEqual({
		gpu: view.gpu,
		host: view.host,
		jobs: [{ ...job, name: "Анонимное задание" }],
		label: view.label,
		queued: 4,
		running: 1,
		state: "working",
	});
	expect(menu.status?.jobs[0]?.progress).toEqual({
		percent: 37.5,
		phase: "sampling",
		phaseTitle: "Генерация",
		scope: "node",
		step: 3,
		totalSteps: 8,
		updatedAt: 1_790_000_000_000,
	});
	for (const secret of [
		"private command",
		"private prompt",
		"private worker text",
		"private workflow",
		"private renamed title",
		"Modeler",
		"workflow",
		"command",
	]) {
		expect(JSON.stringify(menu)).not.toContain(secret);
	}
});

test("tray tips show real zero or unknown progress and retain the owner's hold", () => {
	const view = (progress: unknown, changes: Record<string, unknown> = {}) =>
		queueView(
			SERVICES,
			status({ active_jobs: [{ id: JOB, progress }], ...changes }),
			null
		);
	expect(
		trayMenu(view({ percent: 0, phase: "loading", scope: "job" }), HUB).tip
	).toBe("очередь: Загрузка модели · 0% задания");
	expect(
		trayMenu(view({ percent: null, phase: "decode", scope: "stage" }), HUB).tip
	).toBe("очередь: Декодирование");
	const stopped = trayMenu(
		view(
			{
				percent: 50,
				phase: "sampling",
				scope: "stage",
				step: 4,
				total_steps: 8,
			},
			{ stopped: true }
		),
		HUB
	);
	expect(stopped.tip).toBe(
		"очередь: Генерация · 50% этапа · 4/8 · остановлена"
	);
	expect(stopped.status?.state).toBe("stopped");
	expect(stopped.status?.jobs[0]?.progress?.percent).toBe(50);
});

test("several active jobs keep individual hover progress without an invented combined percentage", () => {
	const view = queueView(
		SERVICES,
		status({
			active_jobs: [
				{
					id: "gpu-job",
					progress: { percent: 20, phase: "sampling", scope: "node" },
				},
				{
					id: "cpu-job",
					progress: { percent: 70, phase: "saving", scope: "job" },
				},
			],
		}),
		null
	);
	const menu = trayMenu(view, HUB);
	expect(menu.tip).toBe("очередь: выполняется 2 · GPU 12%");
	expect(menu.status?.jobs.map((job) => job.progress?.percent)).toEqual([
		20, 70,
	]);
	// The queue may know about jobs missing from its active listing: one listed job is still not the whole queue.
	expect(trayMenu({ ...view, jobs: view.jobs.slice(0, 1) }, HUB).tip).toBe(
		"очередь: выполняется 2 · GPU 12%"
	);
});

test("the hub reads both services and the cached queue plan with the project's token, and only on this computer", async () => {
	const { calls, queue, reads } = fixture({
		"GET 8765/api/queue-plan": () =>
			Response.json({
				jobs: [
					{
						estimate: { resource: "gpu" },
						job_id: "waiting",
						name: "Waiting render",
					},
				],
			}),
		"GET 8765/api/status": () => Response.json(status({ queued_count: 4 })),
		"GET 8766/api/executors": () => Response.json([modeler()]),
	});
	const view = await queue.view();
	expect(view).toMatchObject({
		executorsService: "inference/executors",
		queued: 4,
		queuedJobs: [{ id: "waiting", name: "Waiting render", resource: "gpu" }],
		service: "inference/queue",
		state: "ready",
	});
	expect(view?.executors?.[0]).toMatchObject({
		acceptOnStart: { enabled: true },
		id: "modeler",
		paired: true,
	});
	expect(calls.map((call) => `${call.method} ${call.url}`).sort()).toEqual([
		"GET http://127.0.0.1:8765/api/queue-plan",
		"GET http://127.0.0.1:8765/api/status",
		"GET http://127.0.0.1:8766/api/executors",
	]);
	expect(
		calls.every((call) => call.authorization === "Bearer secret-token")
	).toBe(true);
	expect(new Set(reads)).toEqual(new Set([TOKEN_FILE]));
	expect((await queue.tray(HUB)).items).toHaveLength(5);

	const remote = fixture(
		{ "GET 8765/api/status": () => Response.json(status()) },
		{ services: [queueService({ host: "queue.example.test" })] }
	);
	expect((await remote.queue.view())?.state).toBe("offline");
	expect(remote.calls).toEqual([]);
	await expect(remote.queue.act("pause")).rejects.toThrow("на этом компьютере");
	expect(remote.calls).toEqual([]);
});

test("a queue that is not declared is absent; one that is silent, tokenless or broken is offline", async () => {
	const absent = fixture({}, { services: [{ id: "web", name: "Web" }] });
	expect(await absent.queue.view()).toBeNull();
	expect(await absent.queue.tray(HUB)).toEqual({ items: [], tip: "" });
	await expect(absent.queue.act("stop")).rejects.toThrow("не подключена");
	await expect(absent.queue.executor("modeler", "enable")).rejects.toThrow(
		"не подключены"
	);

	const silent = fixture({});
	expect(await silent.queue.view()).toMatchObject({
		executors: null,
		state: "offline",
	});
	await expect(silent.queue.act("pause")).rejects.toThrow(
		"inference/queue не отвечает"
	);

	const tokenless = fixture(
		{ "GET 8765/api/status": () => Response.json(status()) },
		{ token: null }
	);
	expect((await tokenless.queue.view())?.state).toBe("offline");
	expect(tokenless.calls).toEqual([]);
	await expect(tokenless.queue.act("pause")).rejects.toThrow("нет токена");

	const broken = fixture({
		"GET 8765/api/status": () => new Response("<html>", { status: 502 }),
		"GET 8766/api/executors": () => Response.json({ detail: "not a list" }),
	});
	expect(await broken.queue.view()).toMatchObject({
		executors: null,
		state: "offline",
	});

	// The queue runs and its executors' host does not: the queue is shown without them.
	const alone = fixture(
		{ "GET 8765/api/status": () => Response.json(status()) },
		{ services: [queueService()] }
	);
	expect(await alone.queue.view()).toMatchObject({
		executors: null,
		executorsService: null,
		state: "ready",
	});
	expect(alone.calls).toHaveLength(2);
});

test("an unavailable queue plan does not hide a healthy queue or its own waiting count", async () => {
	const { queue } = fixture({
		"GET 8765/api/queue-plan": () =>
			Response.json({ detail: "Not found" }, { status: 404 }),
		"GET 8765/api/status": () => Response.json(status({ queued_count: 4 })),
	});
	expect(await queue.view()).toMatchObject({
		queued: 4,
		queuedJobs: null,
		state: "ready",
	});
});

test("selected job details project operational diagnostics without reading or renewing the raw job", async () => {
	const { calls, queue } = fixture({
		[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
			Response.json({
				events: [{ data: "private event payload" }],
				job: {
					allocation: {
						backend_urls: ["http://private-backend"],
						cpu_threads: 4,
						expected_seconds: 160.5,
						gpu_compute_pct: 85,
						ram_mb: 8192,
						vram_mb: 4096,
					},
					created: 1_760_000_000.4,
					decision: { position: 2, wait: { summary: "Ждёт свободную GPU" } },
					finished: null,
					id: JOB,
					metrics: { peak_ram_mb: 6000, peak_vram_mb: 3000 },
					output: { bytes: 2048, quiet_seconds: 2.5 },
					pid: 456,
					priority: 50,
					profile: "render",
					queued_seconds: 3.5,
					resource: "gpu",
					result: "private result",
					running_seconds: 12,
					spec: { command: "private command", workflow: "private workflow" },
					stack: "private stack",
					started: 1_760_000_003.9,
					state: "running",
				},
			}),
	});
	const details = await queue.job(JOB);
	expect(details).toEqual({
		cancelRequested: false,
		cpuThreads: 4,
		createdAt: 1_760_000_000_400,
		expectedSeconds: 160.5,
		finishedAt: null,
		gpuCompute: 85,
		id: JOB,
		outputBytes: 2048,
		peakRamMb: 6000,
		peakVramMb: 3000,
		pid: 456,
		position: 2,
		priority: 50,
		profile: "render",
		queuedSeconds: 3.5,
		quietSeconds: 2.5,
		ramMb: 8192,
		resource: "gpu",
		runningSeconds: 12,
		startedAt: 1_760_000_003_900,
		state: "running",
		vramMb: 4096,
		waitingFor: "Ждёт свободную GPU",
	});
	expect(JSON.stringify(details)).not.toContain("private");
	expect(calls).toEqual([
		{
			authorization: "Bearer secret-token",
			body: null,
			method: "GET",
			url: `http://127.0.0.1:8765/api/jobs/${JOB}/diagnostics`,
		},
	]);
});

test("waiting job details use scheduler estimates and tolerate unavailable optional diagnostics", async () => {
	const { queue } = fixture({
		[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
			Response.json({
				job: {
					decision: {
						estimate: {
							cpu_threads: 2,
							ram_mb: 4096,
							resource: "cpu",
							vram_mb: 0,
						},
						waiting_for: ["Waiting for RAM", 7],
					},
					id: JOB,
					pid: "not a number",
					state: "queued",
				},
			}),
	});
	expect(await queue.job(JOB)).toMatchObject({
		cpuThreads: 2,
		createdAt: null,
		finishedAt: null,
		outputBytes: null,
		pid: null,
		profile: null,
		ramMb: 4096,
		resource: "cpu",
		startedAt: null,
		vramMb: 0,
		waitingFor: "Waiting for RAM",
	});
});

test("cancellation requested in another client is visible in active rows and selected diagnostics", async () => {
	const view = queueView(
		SERVICES,
		status({
			active_jobs: [
				{ cancel: 1, id: "numeric", name: "Numeric flag" },
				{ cancel: true, id: "boolean", name: "Boolean flag" },
				{ cancel: 0, id: "idle", name: "No request" },
			],
		}),
		null
	);
	expect(view.jobs[0]?.cancelRequested).toBe(true);
	expect(view.jobs[1]?.cancelRequested).toBe(true);
	expect(view.jobs[2]).not.toHaveProperty("cancelRequested");
	await Promise.all(
		[1, true].map(async (cancel) => {
			const { queue } = fixture({
				[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
					Response.json({ job: { cancel, id: JOB, state: "running" } }),
			});
			expect((await queue.job(JOB)).cancelRequested).toBe(true);
		})
	);
});

test("invalid job IDs are rejected before token reads or network requests", async () => {
	const { calls, queue, reads } = fixture({});
	await Promise.all(
		[
			"",
			"job-1",
			"../queue/continue",
			`${JOB}?private-key=secret`,
			`${JOB}/logs`,
		].map((id) => expect(queue.job(id)).rejects.toMatchObject({ status: 400 }))
	);
	expect(calls).toEqual([]);
	expect(reads).toEqual([]);
});

test("private job refusals and broken diagnostics do not expose a partial detailed response", async () => {
	const hidden = fixture({
		[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
			Response.json({ detail: "Job not found" }, { status: 404 }),
	});
	await expect(hidden.queue.job(JOB)).rejects.toMatchObject({
		message: "Job not found",
		status: 404,
	});
	const privateAnswer = fixture({
		[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
			Response.json({
				job: { id: JOB, private: true, profile: "Hidden profile" },
			}),
	});
	await expect(privateAnswer.queue.job(JOB)).rejects.toMatchObject({
		status: 404,
	});
	const wrongJob = fixture({
		[`GET 8765/api/jobs/${JOB}/diagnostics`]: () =>
			Response.json({ job: { id: "another job" } }),
	});
	await expect(wrongJob.queue.job(JOB)).rejects.toMatchObject({ status: 502 });
	const offline = fixture({});
	await expect(offline.queue.job(JOB)).rejects.toThrow("не отвечает");
});

test("job cancellation distinguishes waiting and explicitly requested running work and discards private payloads", async () => {
	const { calls, queue } = fixture({
		[`POST 8765/api/jobs/${JOB}/cancel`]: () =>
			Response.json({
				name: "Private title",
				private: true,
				spec: { private: true },
			}),
	});
	expect(await queue.cancelJob(JOB, "queued")).toBeUndefined();
	expect(await queue.cancelJob(JOB, "running")).toBeUndefined();
	expect(calls).toEqual([
		{
			authorization: "Bearer secret-token",
			body: null,
			method: "POST",
			url: `http://127.0.0.1:8765/api/jobs/${JOB}/cancel?require_unstarted=true`,
		},
		{
			authorization: "Bearer secret-token",
			body: null,
			method: "POST",
			url: `http://127.0.0.1:8765/api/jobs/${JOB}/cancel?require_unstarted=false`,
		},
	]);
});

test("invalid cancellation IDs or states do not reach the queue or its token", async () => {
	const { calls, queue, reads } = fixture({});
	await Promise.all([
		expect(queue.cancelJob("not-a-uuid", "queued")).rejects.toMatchObject({
			status: 400,
		}),
		...(
			[undefined, null, "succeeded", true, { state: "queued" }] as unknown[]
		).map((state) =>
			expect(queue.cancelJob(JOB, state)).rejects.toMatchObject({ status: 400 })
		),
	]);
	expect(calls).toEqual([]);
	expect(reads).toEqual([]);
});

test("a waiting cancellation refuses a started or held job without an unguarded retry", async () => {
	const { calls, queue } = fixture({
		[`POST 8765/api/jobs/${JOB}/cancel`]: () =>
			Response.json(
				{
					detail:
						"Job is not a never-started queued request; cancellation refused",
				},
				{ status: 409 }
			),
	});
	await expect(queue.cancelJob(JOB, "queued")).rejects.toMatchObject({
		status: 409,
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toEndWith("?require_unstarted=true");
	const refused = fixture({
		[`POST 8765/api/jobs/${JOB}/cancel`]: () =>
			Response.json({ detail: "Job not found" }, { status: 404 }),
	});
	await expect(refused.queue.cancelJob(JOB, "queued")).rejects.toMatchObject({
		message: "Job not found",
		status: 404,
	});
});

test("attempted cancellation invalidates the shared queue reading even after a refusal", async () => {
	let readings = 0;
	const responses = new Set<"refused">();
	const queue = new Queue(() => catalogue([queueService()]), {
		fetch: (url) => {
			if (url.includes("/cancel?")) {
				return Promise.resolve(
					responses.has("refused")
						? Response.json({ detail: "Queue stopped" }, { status: 409 })
						: Response.json({ private: true })
				);
			}
			if (url.endsWith("/api/status")) {
				readings += 1;
				return Promise.resolve(Response.json(status()));
			}
			return Promise.resolve(Response.json({ jobs: [] }));
		},
		freshMs: 60_000,
		readFile: () => Promise.resolve("secret-token"),
	});
	await queue.view();
	await queue.cancelJob(JOB, "queued");
	await queue.view();
	expect(readings).toBe(2);
	responses.add("refused");
	await expect(queue.cancelJob(JOB, "queued")).rejects.toMatchObject({
		status: 409,
	});
	await queue.view();
	expect(readings).toBe(3);
});

test("commands go to the queue's own addresses, and its refusal is the error shown", async () => {
	const ok = () => Response.json({ ok: true });
	const { calls, queue } = fixture({
		"POST 8765/api/pause": ok,
		"POST 8765/api/queue/continue": ok,
		"POST 8765/api/queue/stop": () =>
			Response.json({ detail: "Очередь уже остановлена" }, { status: 409 }),
		"POST 8765/api/resume": () =>
			Response.json({ detail: [{ msg: "not text" }] }, { status: 422 }),
		"POST 8766/api/executors/modeler/accept-on-start": ok,
		"POST 8766/api/executors/modeler/enable": ok,
		"POST 8766/api/executors/modeler/pause": () =>
			Response.json({ detail: "Исполнитель не подключён" }, { status: 409 }),
	});
	await queue.act("pause");
	await queue.act("continue");
	await expect(queue.act("stop")).rejects.toThrow("Очередь уже остановлена");
	await expect(queue.act("resume")).rejects.toThrow(
		"inference/queue ответил HTTP 422"
	);
	await expect(queue.act("restart")).rejects.toThrow(
		"неизвестное действие restart"
	);
	await queue.executor("modeler", "enable");
	await queue.executor("modeler", "accept-on");
	await queue.executor("modeler", "accept-off");
	await expect(queue.executor("modeler", "pause")).rejects.toThrow(
		"Исполнитель не подключён"
	);
	await expect(queue.executor("modeler", "delete")).rejects.toThrow(
		"неизвестное действие delete"
	);
	await expect(queue.executor("../status", "enable")).rejects.toThrow(
		"нет исполнителя"
	);
	expect(
		calls.map(
			(call) => `${call.method} ${call.url.slice("http://127.0.0.1:".length)}`
		)
	).toEqual([
		"POST 8765/api/pause",
		"POST 8765/api/queue/continue",
		"POST 8765/api/queue/stop",
		"POST 8765/api/resume",
		"POST 8766/api/executors/modeler/enable",
		"POST 8766/api/executors/modeler/accept-on-start",
		"POST 8766/api/executors/modeler/accept-on-start",
		"POST 8766/api/executors/modeler/pause",
	]);
	expect(calls.map((call) => call.body)).toEqual([
		null,
		null,
		null,
		null,
		null,
		'{"enabled":true}',
		'{"enabled":false}',
		null,
	]);
	expect(
		calls.every((call) => call.authorization === "Bearer secret-token")
	).toBe(true);
});

test("the page and the tray asking together share one reading, and a command ends it", async () => {
	let readings = 0;
	let plans = 0;
	const queue = new Queue(() => catalogue([queueService()]), {
		fetch: (url, init) => {
			if (init.method === "GET") {
				if (url.endsWith("/api/queue-plan")) {
					plans += 1;
					return Promise.resolve(Response.json({ jobs: [] }));
				}
				readings += 1;
			}
			return Promise.resolve(Response.json(status()));
		},
		freshMs: 60_000,
		readFile: () => Promise.resolve("secret-token"),
	});
	await Promise.all([queue.view(), queue.tray(HUB), queue.view()]);
	expect(readings).toBe(1);
	expect(plans).toBe(1);
	await queue.act("pause");
	await queue.view();
	expect(readings).toBe(2);
	expect(plans).toBe(2);
});
