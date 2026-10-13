import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { QueueJobDetails } from "../queue";
import { JobDetailDialog, JobFacts, readJobDetails } from "./job-details";

const noop = () => undefined;

const detail: QueueJobDetails = {
	cancelRequested: false,
	cpuThreads: 4,
	createdAt: 1_791_800_000_000,
	expectedSeconds: 180,
	finishedAt: null,
	gpuCompute: 80,
	id: "6aa6c477-8b45-4796-86fe-1a90774e0df1",
	outputBytes: 0,
	peakRamMb: 2048,
	peakVramMb: 1024,
	pid: 1234,
	position: null,
	priority: 0,
	profile: "render",
	queuedSeconds: 0,
	quietSeconds: 0,
	ramMb: 8192,
	resource: "gpu",
	runningSeconds: 65,
	startedAt: 1_791_800_000_000,
	state: "running",
	vramMb: 4096,
	waitingFor: null,
};

test("job details use the protected read-only endpoint", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ job: detail })
	);
	try {
		expect(await readJobDetails(detail.id)).toEqual(detail);
		expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/queue/jobs/${detail.id}`);
		expect(fetcher.mock.calls[0]?.[1]).toEqual({
			headers: { "x-devhub": "1" },
		});
		fetcher.mockResolvedValue(
			Response.json({ error: "Задание недоступно" }, { status: 404 })
		);
		await expect(readJobDetails(detail.id)).rejects.toThrow(
			"Задание недоступно"
		);
	} finally {
		fetcher.mockRestore();
	}
});

test("details retain zero readings and omit unknown fields", () => {
	const markup = renderToStaticMarkup(<JobFacts detail={detail} />);
	expect(markup).toContain("Выполняется");
	expect(markup).toContain("1 мин 5 с");
	expect(markup).toContain("4 ГБ");
	expect(markup).toContain("8 ГБ");
	expect(markup).toContain("Приоритет</dt><dd>0");
	expect(markup).toContain("0 байт");
	expect(markup).not.toContain("Завершено");
	expect(markup).not.toContain("Позиция в очереди");
});

test("queued details explain the wait and private dialogs do not expose titles", () => {
	const markup = renderToStaticMarkup(
		<JobFacts
			detail={{
				...detail,
				position: 2,
				state: "queued",
				waitingFor: "Ждёт видеопамять",
			}}
		/>
	);
	expect(markup).toContain("Ждёт видеопамять");
	expect(markup).toContain("Позиция в очереди</dt><dd>2");
	const privateMarkup = renderToStaticMarkup(
		<JobDetailDialog
			initialState="queued"
			job={{
				id: detail.id,
				name: "Secret title",
				private: true,
				resource: "gpu",
				startedAt: null,
			}}
			onClose={noop}
		/>
	);
	expect(privateMarkup).toContain("Анонимное задание");
	expect(privateMarkup).toContain("Подробности приватного задания скрыты");
	expect(privateMarkup).not.toContain("Secret title");
	expect(privateMarkup).not.toContain("Обновить");
});
