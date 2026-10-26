import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { QueueView } from "../queue";
import { ComputerResources } from "./computer-resources";

const NOW = 100_000;
const PROGRESS = /<progress\b/g;

function queue(changes: Partial<QueueView> = {}): QueueView {
	return {
		executors: null,
		executorsService: null,
		gpu: {
			name: "NVIDIA GeForce RTX 5080",
			temperature: 57.2,
			totalMb: 16_384,
			usedMb: 2048,
			utilization: 6,
		},
		host: { availableMb: 12_800, cpu: 45.6, totalMb: 65_536 },
		jobs: [],
		label: "Общая очередь готова",
		panel: "#/inference/queue",
		queued: 4,
		queuedJobs: [],
		running: 0,
		service: "inference/queue",
		state: "ready",
		waitingFor: [],
		...changes,
	};
}

test("computer resources show measured GPU, used VRAM, available RAM and CPU in correct units", () => {
	const markup = renderToStaticMarkup(
		<ComputerResources available now={NOW} queue={queue()} receivedAt={NOW} />
	);
	for (const value of [
		"6% · 57 °C",
		"NVIDIA GeForce RTX 5080",
		"2,0 ГБ",
		"из 16,0 ГБ · свободно 14,0 ГБ",
		"12,5 ГБ",
		"свободно из 64,0 ГБ · занято 51,5 ГБ",
		"46%",
		"Получено в",
	]) {
		expect(markup).toContain(value);
	}
	expect(markup.match(PROGRESS)?.length).toBe(4);
	expect(markup).toContain('aria-label="Занято оперативной памяти"');
});

test("a failed poll never displays retained resource measurements as current", () => {
	const markup = renderToStaticMarkup(
		<ComputerResources
			available={false}
			now={NOW}
			queue={queue()}
			receivedAt={NOW}
		/>
	);
	expect(markup).toContain("Нет актуальных данных");
	expect(markup).toContain("Последнее получение данных");
	expect(markup).not.toContain("NVIDIA");
	expect(markup).not.toContain("57 °C");
	expect(markup).not.toContain("<progress");
});

test("stale and offline readings are hidden while paused or owner-stopped queues keep valid telemetry", () => {
	const stale = renderToStaticMarkup(
		<ComputerResources
			available
			now={NOW + 15_001}
			queue={queue()}
			receivedAt={NOW}
		/>
	);
	expect(stale).toContain("Данные устарели");
	expect(stale).not.toContain("NVIDIA");
	const offline = renderToStaticMarkup(
		<ComputerResources
			available
			now={NOW}
			queue={queue({ state: "offline" })}
			receivedAt={NOW}
		/>
	);
	expect(offline).not.toContain("NVIDIA");
	for (const state of ["paused", "stopped"] as const) {
		const markup = renderToStaticMarkup(
			<ComputerResources
				available
				now={NOW}
				queue={queue({ state })}
				receivedAt={NOW}
			/>
		);
		expect(markup).toContain("NVIDIA");
		expect(markup).toContain("6% · 57 °C");
	}
});

test("missing and invalid sensors do not invent zeroes, NaN or overflowing meters", () => {
	const absent = renderToStaticMarkup(
		<ComputerResources available now={NOW} queue={null} receivedAt={null} />
	);
	expect(absent).toContain("Ожидаем данные Inference");
	expect(absent).not.toContain("<progress");
	const invalid = queue({
		gpu: {
			name: "GPU",
			temperature: 57,
			totalMb: 0,
			usedMb: -2,
			utilization: -3,
		},
		host: { availableMb: 80_000, cpu: 101, totalMb: 65_536 },
	});
	const markup = renderToStaticMarkup(
		<ComputerResources available now={NOW} queue={invalid} receivedAt={NOW} />
	);
	expect(markup).not.toContain("-3%");
	expect(markup).not.toContain("101%");
	expect(markup).not.toContain("NaN");
	expect(markup).not.toContain("<progress");
});

test("genuine zero load remains a valid observation", () => {
	const idle = queue({
		gpu: {
			name: "GPU",
			temperature: 40,
			totalMb: 16_384,
			usedMb: 0,
			utilization: 0,
		},
		host: { availableMb: 65_536, cpu: 0, totalMb: 65_536 },
	});
	const markup = renderToStaticMarkup(
		<ComputerResources available now={NOW} queue={idle} receivedAt={NOW} />
	);
	expect(markup).toContain("0% · 40 °C");
	expect(markup).toContain("0,0 ГБ");
	expect(markup).toContain("64,0 ГБ");
	expect(markup.match(PROGRESS)?.length).toBe(4);
});
