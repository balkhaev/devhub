import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AiAccountView, AiProviderView } from "../ai/types";
import { AiAccount, AiProviderCard } from "./ai-accounts";
import { type AiStreamEvent, aiChat, aiRequest } from "./ai-api";
import { AiConversation, AiPlayground } from "./ai-playground";

const refresh = async () => undefined;
const DISABLED_TOKEN_LIMIT = /<input[^>]*disabled=""[^>]*max="32768"/;
const account: AiAccountView = {
	email: "user@example.test",
	id: "sample-account",
	label: "Personal account",
	provider: "codex",
	source: "codex-cli",
	status: "connected",
};
const provider: AiProviderView = {
	description: "Personal ChatGPT subscription",
	id: "codex",
	models: [{ id: "gpt-test", name: "Test model" }],
	name: "OpenAI Codex",
};

function streamed(chunks: Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(chunk);
				}
				controller.close();
			},
		})
	);
}

test("subscription controls show safe account status and both connection methods", () => {
	const markup = renderToStaticMarkup(
		<AiProviderCard
			accounts={[account]}
			onRefresh={refresh}
			provider={provider}
		/>
	);
	expect(markup).toContain("Подключён");
	expect(markup).toContain("Подключить подписку");
	expect(markup).toContain("Импорт из Codex CLI");
	expect(markup).toContain("Отключить в DevHub");
	expect(markup).not.toContain("accessToken");
	expect(markup).not.toContain("refreshToken");
});

test("an expired subscription asks for a new login", () => {
	const markup = renderToStaticMarkup(
		<AiAccount
			account={{ ...account, status: "expired" }}
			onRefresh={refresh}
		/>
	);
	expect(markup).toContain("Вход истёк");
	expect(markup).toContain("ai-status--expired");
});

test("an existing OAuth account can be reauthorized from its own card", () => {
	const markup = renderToStaticMarkup(
		<AiProviderCard
			accounts={[{ ...account, source: "oauth", status: "expired" }]}
			onRefresh={refresh}
			provider={provider}
		/>
	);
	expect(markup).toContain("Войти заново");
	expect(markup).toContain("Вход истёк");
});

test("Codex CLI makes its unsupported output limit visible and unavailable", () => {
	const markup = renderToStaticMarkup(
		<AiPlayground accounts={[account]} providers={[provider]} />
	);
	expect(markup).toContain("не поддерживает лимит токенов ответа");
	expect(markup).toMatch(DISABLED_TOKEN_LIMIT);
});

test("model output remains text rather than executable HTML", () => {
	const markup = renderToStaticMarkup(
		<AiConversation
			messages={[
				{
					content: "<script>alert('x')</script>",
					id: "reply",
					role: "assistant",
				},
			]}
			pending={false}
		/>
	);
	expect(markup).not.toContain("<script>");
	expect(markup).toContain("&lt;script&gt;");
});

test("AI reads carry the browser guard and prevent cache reuse", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ accounts: [], providers: [] })
	);
	try {
		await aiRequest("state");
		expect(fetcher.mock.calls[0]?.[0]).toBe("/api/ai/state");
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			cache: "no-store",
			headers: { "Content-Type": "application/json", "x-devhub": "1" },
			method: "GET",
		});
	} finally {
		fetcher.mockRestore();
	}
});

test("AI stream handles split UTF-8, split JSON and a final line without newline", async () => {
	const encoded = new TextEncoder().encode(
		'{"type":"text","text":"Привет"}\n{"type":"done","usage":{"inputTokens":2,"outputTokens":3}}'
	);
	const chunks = [
		encoded.slice(0, 25),
		encoded.slice(25, 29),
		encoded.slice(29, 46),
		encoded.slice(46),
	];
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		streamed(chunks)
	);
	const events: AiStreamEvent[] = [];
	const { signal } = new AbortController();
	try {
		await aiChat(
			{
				accountId: account.id,
				messages: [{ content: "Hello", role: "user" }],
				model: "gpt-test",
			},
			(event) => events.push(event),
			signal
		);
		expect(events).toEqual([
			{ text: "Привет", type: "text" },
			{ type: "done", usage: { inputTokens: 2, outputTokens: 3 } },
		]);
		expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(signal);
		expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
			"Content-Type": "application/json",
			"x-devhub": "1",
		});
	} finally {
		fetcher.mockRestore();
	}
});

test("AI stream reports truncation while keeping already delivered text", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		streamed([new TextEncoder().encode('{"type":"text","text":"partial"}\n')])
	);
	const events: AiStreamEvent[] = [];
	try {
		await expect(
			aiChat(
				{ accountId: account.id, messages: [], model: "gpt-test" },
				(event) => events.push(event),
				new AbortController().signal
			)
		).rejects.toThrow("Поток оборвался");
		expect(events).toEqual([{ text: "partial", type: "text" }]);
	} finally {
		fetcher.mockRestore();
	}
});

test("AI stream exposes the server's safe error and does not emit it as model text", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		streamed([
			new TextEncoder().encode(
				'{"type":"error","error":"Лимит подписки исчерпан"}\n'
			),
		])
	);
	const events: AiStreamEvent[] = [];
	try {
		await expect(
			aiChat(
				{ accountId: account.id, messages: [], model: "gpt-test" },
				(event) => events.push(event),
				new AbortController().signal
			)
		).rejects.toThrow("Лимит подписки исчерпан");
		expect(events).toEqual([]);
	} finally {
		fetcher.mockRestore();
	}
});
