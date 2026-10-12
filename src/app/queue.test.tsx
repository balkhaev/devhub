import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { HubView, ServiceStatus } from "../hub";
import type { QueueExecutor, QueueView } from "../queue";
import { QueueCard, QueueSection, readQueue } from "./queue";

const noop = () => undefined;
const STOP_BUTTON =
	/<button[^>]*data-confirm="Остановить очередь\? Работающие задания доработают, новые не начнутся, пока вы её не продолжите\."[^>]*data-path="\/api\/queue\/stop"[^>]*>Стоп очереди<\/button>/;
const PAUSE_BUTTON =
	/<button[^>]*data-path="\/api\/queue\/pause"[^>]*>Пауза<\/button>/;
const CONTINUE_BUTTON =
	/<button[^>]*data-path="\/api\/queue\/continue"[^>]*>Продолжить<\/button>/;
const START_BUTTON =
	/<button[^>]*data-path="\/api\/services\/inference\/queue\/start"[^>]*>Запустить<\/button>/;
const ENABLE_BUTTON =
	/<button class="button button--small" data-path="\/api\/queue\/executors\/modeler\/enable" title="Modeler: принимать заказы" type="button">Принимать<\/button>/;
const DISABLED_STOP_BUTTON =
	/<button[^>]*data-path="\/api\/queue\/executors\/modeler\/stop"[^>]*disabled=""[^>]*>Стоп<\/button>/;
const CHECKED_SWITCH =
	/<input data-path="\/api\/queue\/executors\/modeler\/accept-off" type="checkbox" checked=""\/>Modeler: принимать заказы при запуске/;
const UNCHECKED_SWITCH =
	/<input data-path="\/api\/queue\/executors\/montage\/accept-on" type="checkbox"\/>Montage: при запуске/;

function queue(changes: Partial<QueueView> = {}): QueueView {
	return {
		executors: null,
		executorsService: "inference/executors",
		gpu: {
			name: "NVIDIA GeForce RTX 5080",
			temperature: 61.4,
			totalMb: 16_303,
			usedMb: 4096,
			utilization: 86.6,
		},
		host: { availableMb: 40_960, cpu: 7.4, totalMb: 65_536 },
		jobs: [],
		label: "Общая очередь готова · GPU 87%",
		panel: "#/inference/queue",
		queued: 0,
		running: 0,
		service: "inference/queue",
		state: "ready",
		waitingFor: [],
		...changes,
	};
}

function executor(changes: Partial<QueueExecutor> = {}): QueueExecutor {
	return {
		accepting: false,
		acceptOnStart: {
			enabled: true,
			text: "Modeler: принимать заказы при запуске",
		},
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
				id: "stop",
				short: "Стоп",
				text: "Modeler: остановить",
			},
		],
		connected: true,
		error: "",
		id: "modeler",
		label: "На паузе · приём выключен",
		name: "Modeler",
		note: "Последний заказ выполнен",
		paired: true,
		site: null,
		...changes,
	};
}

const card = (view: QueueView, status: ServiceStatus | null = "running") =>
	renderToStaticMarkup(
		<QueueCard onAction={noop} queue={view} status={status} />
	);

test("a working queue shows its load, what runs and waits, and offers a stop and a pause", () => {
	const markup = card(
		queue({
			jobs: [
				{
					id: "job-1",
					name: "Render shot 12",
					private: false,
					resource: "gpu",
					startedAt: Date.now() - 5 * 60_000,
				},
				{
					id: "job-2",
					name: "Анонимное задание",
					private: true,
					resource: "cpu",
					startedAt: null,
				},
			],
			label: "Выполняется: 2 · GPU 87%",
			queued: 3,
			running: 2,
			state: "working",
			waitingFor: ["GPU owned by another inference worker"],
		})
	);
	expect(markup).toContain("Общая очередь");
	expect(markup).toContain("Выполняется: 2 · GPU 87%");
	expect(markup).toContain(
		'<span class="dot dot--running"></span> Общая очередь'
	);
	expect(markup).toContain(
		'<a class="button button--small" href="#/inference/queue">Панель очереди</a>'
	);
	expect(markup).toContain("87% · 61 °C");
	expect(markup).toContain("4,0 из 15,9 ГБ");
	expect(markup).toContain("свободно 40,0 из 64,0 ГБ");
	expect(markup).toContain("7%");
	expect(markup).toContain('title="NVIDIA GeForce RTX 5080"');
	expect(markup).toContain('width="87"');
	expect(markup).toContain("Render shot 12");
	expect(markup).toContain("GPU · 5 минут");
	expect(markup).toContain("Анонимное задание");
	expect(markup).toContain('<span class="muted small">CPU</span>');
	expect(markup).toContain("В очереди: 3");
	// Why nothing runs is said only while nothing does.
	expect(markup).not.toContain("GPU owned by another inference worker");
	expect(markup).toMatch(STOP_BUTTON);
	expect(markup).toMatch(PAUSE_BUTTON);
	expect(markup).not.toMatch(CONTINUE_BUTTON);
	expect(markup).not.toContain("Очередь не отвечает");
});

test("the buttons follow the queue's state like the tray menu does", () => {
	const ready = card(queue({ waitingFor: ["Ждёт видеопамять"] }));
	expect(ready).toMatch(STOP_BUTTON);
	expect(ready).toMatch(PAUSE_BUTTON);
	expect(ready).not.toContain("В очереди");
	expect(ready).toContain("Ждёт видеопамять");

	const paused = card(queue({ label: "Очередь на паузе", state: "paused" }));
	expect(paused).toContain('<span class="dot dot--paused"></span>');
	expect(paused).toMatch(STOP_BUTTON);
	expect(paused).toMatch(CONTINUE_BUTTON);
	expect(paused).not.toMatch(PAUSE_BUTTON);

	const stopped = card(
		queue({ label: "Очередь остановлена", state: "stopped" })
	);
	expect(stopped).toContain('<span class="dot dot--crashed"></span>');
	expect(stopped).toMatch(CONTINUE_BUTTON);
	expect(stopped).not.toMatch(STOP_BUTTON);
	expect(stopped).not.toMatch(PAUSE_BUTTON);
});

test("a silent queue says so and can be started only when its service is down", () => {
	const offline = queue({
		gpu: null,
		host: null,
		label: "Нет связи с очередью",
		queued: null,
		state: "offline",
	});
	const down = card(offline, "stopped");
	expect(down).toContain('<span class="dot"></span> Общая очередь');
	expect(down).toContain("Нет связи с очередью");
	expect(down).toContain("Очередь не отвечает.");
	expect(down).toMatch(START_BUTTON);
	expect(down).not.toMatch(STOP_BUTTON);
	expect(down).not.toMatch(PAUSE_BUTTON);
	expect(down).not.toMatch(CONTINUE_BUTTON);
	expect(down).not.toContain("meter");
	expect(card(offline, "crashed")).toMatch(START_BUTTON);
	for (const status of ["running", "external", "busy", "unhealthy"] as const) {
		const up = card(offline, status);
		expect(up).toContain("Очередь не отвечает.");
		expect(up).not.toMatch(START_BUTTON);
	}
	const starting = card(offline, "starting");
	expect(starting).toContain("Очередь запускается и пока не отвечает.");
	expect(starting).not.toMatch(START_BUTTON);
	expect(card(offline, null)).not.toMatch(START_BUTTON);
});

test("paired executors each get a row with their commands and their switch", () => {
	const markup = card(
		queue({
			executors: [
				executor(),
				executor({ id: "hidden", name: "Not paired", paired: false }),
				executor({
					accepting: true,
					acceptOnStart: { enabled: false, text: "Montage: при запуске" },
					commands: [],
					error: "Нет связи с сайтом",
					id: "montage",
					label: "Принимает заказы",
					name: "Montage",
					note: "",
				}),
			],
		})
	);
	expect(markup).toContain("<strong>Modeler</strong>");
	expect(markup).toContain("На паузе · приём выключен");
	expect(markup).toContain("Последний заказ выполнен");
	expect(markup).toMatch(ENABLE_BUTTON);
	expect(markup).toMatch(DISABLED_STOP_BUTTON);
	expect(markup).toMatch(CHECKED_SWITCH);
	expect(markup).not.toContain("Not paired");
	expect(markup).toContain("<strong>Montage</strong>");
	expect(markup).toMatch(UNCHECKED_SWITCH);
	expect(markup).toContain(
		'<p class="queue__problem small">Нет связи с сайтом</p>'
	);
	expect(markup).toContain(
		'<span class="dot dot--crashed"></span><strong>Montage'
	);

	const none = card(queue({ executors: [executor({ paired: false })] }));
	expect(none).not.toContain("queue__executors");
	// An executor that already says what is wrong is not quoted twice.
	const said = card(
		queue({
			executors: [
				executor({ error: "сайт молчит", note: "Ошибка: сайт молчит" }),
			],
		})
	);
	expect(said).not.toContain("queue__problem");
});

test("the card is read from the hub as its own page, and is absent until the hub has answered", async () => {
	const view = queue();
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ queue: view })
	);
	try {
		expect(await readQueue()).toEqual(view);
		expect(fetcher.mock.calls).toHaveLength(1);
		expect(fetcher.mock.calls[0]?.[0]).toBe("/api/queue");
		expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "x-devhub": "1" });
		fetcher.mockResolvedValue(Response.json({ queue: null }));
		expect(await readQueue()).toBeNull();
	} finally {
		fetcher.mockRestore();
	}
	const hub: HubView = {
		docker: { available: false, projects: [] },
		hub: 1,
		ports: [],
		projects: [],
		updatedAt: 1,
	};
	expect(renderToStaticMarkup(<QueueSection view={hub} />)).toBe("");
});
