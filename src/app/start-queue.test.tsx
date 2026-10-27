import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { QueueJob, QueueView } from "../queue";
import { InferenceQueue } from "./start-queue";

const NOW = 100_000;
const job = (id: string, changes: Partial<QueueJob> = {}): QueueJob => ({
	id,
	name: `Задание ${id}`,
	private: false,
	resource: "gpu",
	startedAt: null,
	...changes,
});
const queue = (changes: Partial<QueueView> = {}): QueueView => ({
	executors: null,
	executorsService: null,
	gpu: null,
	host: null,
	jobs: [],
	label: "Готова",
	panel: "#/inference/queue",
	queued: 0,
	queuedJobs: [],
	running: 0,
	service: "inference/queue",
	state: "ready",
	waitingFor: [],
	...changes,
});
const render = (
	view: QueueView | null,
	available = true,
	receivedAt: number | null = NOW
) =>
	renderToStaticMarkup(
		<InferenceQueue
			available={available}
			now={NOW}
			queue={view}
			receivedAt={receivedAt}
		/>
	);

test("the start page hides an empty, missing, offline, failed or stale queue", () => {
	const active = queue({ queued: 1, queuedJobs: [job("waiting")] });
	for (const view of [
		null,
		queue(),
		queue({ queued: null }),
		queue({ ...active, state: "offline" }),
	]) {
		expect(render(view)).toBe("");
	}
	expect(render(active, false)).toBe("");
	expect(render(active, true, null)).toBe("");
	expect(render(active, true, NOW - 15_001)).toBe("");
	expect(render(active, true, NOW - 15_000)).toContain("Очередь Inference");
});

test("the preview shows running progress before waiting jobs in scheduler order without private names", () => {
	const html = render(
		queue({
			jobs: [
				job("private-running-id", {
					name: "Secret running name",
					private: true,
					progress: {
						percent: 42,
						phase: "sampling",
						phaseTitle: "Генерация",
						scope: "job",
						step: 4,
						totalSteps: 10,
						updatedAt: NOW,
					},
				}),
			],
			queued: 2,
			queuedJobs: [
				job("second"),
				job("third", { name: "Secret queued name", private: true }),
			],
			running: 1,
			state: "working",
		})
	);
	expect(html).toContain("1 выполняется · 2 в очереди");
	expect(html.indexOf("Выполняется")).toBeLessThan(
		html.indexOf("Задание second")
	);
	expect(html.indexOf("Задание second")).toBeLessThan(
		html.lastIndexOf("Анонимное задание")
	);
	expect(html).not.toContain("Secret");
	expect(html).toContain("42% задания");
	expect(html).toContain('value="42"');
	expect(html).toContain('href="#/inference/queue"');
	expect(html).not.toContain('target="_blank"');
	expect(html).not.toContain("<button");
});

test("waiting-only work shows its blocker, even when the listing is unavailable", () => {
	const html = render(
		queue({
			queued: 3,
			queuedJobs: null,
			waitingFor: ["Не хватает видеопамяти"],
		})
	);
	expect(html).toContain("3 в очереди");
	expect(html).toContain("Не хватает видеопамяти");
	expect(html).toContain("Список заданий недоступен");
	expect(html).not.toContain("<h3>Выполняется");
});

test("paused and owner-stopped queues still show work and explain why it waits", () => {
	for (const state of ["paused", "stopped"] as const) {
		const html = render(queue({ queued: 1, queuedJobs: [job("held")], state }));
		expect(html).toContain(
			state === "stopped" ? "Очередь остановлена" : "Очередь на паузе"
		);
		expect(html).toContain("Новые задания ждут");
		expect(html).toContain("Задание held");
	}
});

test("the preview is bounded and preserves known jobs when the total is unknown", () => {
	const jobs = Array.from({ length: 8 }, (_, index) => job(String(index)));
	const html = render(queue({ queued: 10, queuedJobs: jobs }));
	expect(html).toContain("Задание 4");
	expect(html).not.toContain("Задание 5");
	expect(html).toContain("Ещё заданий в панели: 5");
	const unknown = render(queue({ queued: null, queuedJobs: [job("known")] }));
	expect(unknown).toContain("? в очереди");
	expect(unknown).toContain("Задание known");
});
