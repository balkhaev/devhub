import { expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { QueueJob } from "../queue";
import { CancelJobButton, confirmJobCancellation } from "./job-cancel";

const noop = () => undefined;
const job: QueueJob = {
	id: "6aa6c477-8b45-4796-86fe-1a90774e0df1",
	name: "Render shot",
	private: false,
	resource: "gpu",
	startedAt: null,
};

test("declining confirmation or leaving the view prevents the cancellation request", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ ok: true, result: null })
	);
	const sending = mock(noop);
	try {
		const results = await Promise.all(
			[
				[false, true],
				[true, false],
			].map(([accepted, current]) =>
				confirmJobCancellation(
					job,
					"queued",
					() => Promise.resolve(Boolean(accepted)),
					() => Boolean(current),
					sending
				)
			)
		);
		expect(results).toEqual([false, false]);
		expect(fetcher).not.toHaveBeenCalled();
		expect(sending).not.toHaveBeenCalled();
	} finally {
		fetcher.mockRestore();
	}
});

test.each(["queued", "running"] as const)(
	"confirmed %s cancellation sends one explicit state without private inputs",
	async (state) => {
		const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ ok: true, result: null })
		);
		const question = mock((_question: string) => Promise.resolve(true));
		const sending = mock(noop);
		try {
			expect(
				await confirmJobCancellation(
					{ ...job, name: "Private title", private: true },
					state,
					question,
					() => true,
					sending
				)
			).toBe(true);
			expect(question.mock.calls[0]?.[0]).toContain("Анонимное задание");
			expect(question.mock.calls[0]?.[0]).not.toContain("Private title");
			expect(sending).toHaveBeenCalledTimes(1);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]?.[0]).toBe(
				`/api/queue/jobs/${job.id}/cancel`
			);
			expect(fetcher.mock.calls[0]?.[1]).toEqual({
				body: JSON.stringify({ state }),
				headers: { "Content-Type": "application/json", "x-devhub": "1" },
				method: "POST",
			});
		} finally {
			fetcher.mockRestore();
		}
	}
);

test("a queued job that started is not retried as a running cancellation", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ error: "Задание уже началось" }, { status: 409 })
	);
	try {
		await expect(
			confirmJobCancellation(
				job,
				"queued",
				() => Promise.resolve(true),
				() => true,
				noop
			)
		).rejects.toThrow("Задание уже началось");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({ state: "queued" })
		);
	} finally {
		fetcher.mockRestore();
	}
});

test.each([
	"succeeded",
	"cancelled",
	"failed",
	"interrupted",
	"needs_attention",
	null,
])("%s jobs offer no cancellation", (state) => {
	const markup = renderToStaticMarkup(
		<CancelJobButton job={job} onClick={noop} pending={null} state={state} />
	);
	expect(markup).toBe("");
});

test("cancel controls reflect a sending or already requested cancellation and keep the confirmation opener focusable", () => {
	const sending = renderToStaticMarkup(
		<CancelJobButton
			job={job}
			onClick={noop}
			pending={{ id: job.id, phase: "sending" }}
			state="running"
		/>
	);
	expect(sending).toContain("Отменяю…");
	expect(sending).toContain('disabled=""');
	const requested = renderToStaticMarkup(
		<CancelJobButton
			job={{ ...job, cancelRequested: true }}
			onClick={noop}
			pending={null}
			state="running"
		/>
	);
	expect(requested).toContain("Отмена запрошена");
	expect(requested).toContain('disabled=""');
	const confirming = renderToStaticMarkup(
		<CancelJobButton
			job={job}
			onClick={noop}
			pending={{ id: job.id, phase: "confirming" }}
			state="running"
		/>
	);
	expect(confirming).not.toContain('disabled=""');
});
