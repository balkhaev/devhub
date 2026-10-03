import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AiAccountView, AiProviderView } from "../ai/types";
import { AiAccount, AiProviderCard } from "./ai-accounts";
import { type AiStreamEvent, aiChat, aiRequest } from "./ai-api";
import { AiConversation, AiPlayground } from "./ai-playground";
import { AiPoolStatus } from "./ai-pool";
import { AiProxyAccess, AiProxyStats } from "./ai-proxy";
import { AiKeyRow, AiKeySecret } from "./ai-proxy-keys";

const refresh = async () => undefined;
const hideSecret = () => undefined;
const DISABLED_TOKEN_LIMIT = /<input[^>]*disabled=""[^>]*max="32768"/;
const account: AiAccountView = {
	email: "user@example.test",
	enabled: true,
	id: "sample-account",
	label: "Personal account",
	maxConcurrency: 2,
	pool: {
		active: 0,
		completed: 3,
		failed: 1,
		inputTokens: 20,
		outputTokens: 30,
		requests: 4,
		status: "ready",
	},
	priority: 0,
	provider: "codex",
	source: "codex-cli",
	status: "connected",
	weight: 1,
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
	expect(markup).toContain("Добавить подписку");
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

test("OpenAI subscriptions make their unsupported output limit visible and unavailable", () => {
	const markup = renderToStaticMarkup(
		<AiPlayground accounts={[account]} providers={[provider]} />
	);
	expect(markup).toContain("не поддерживает лимит токенов ответа");
	expect(markup).toMatch(DISABLED_TOKEN_LIMIT);
	const oauthMarkup = renderToStaticMarkup(
		<AiPlayground
			accounts={[{ ...account, source: "oauth" }]}
			providers={[provider]}
		/>
	);
	expect(oauthMarkup).toMatch(DISABLED_TOKEN_LIMIT);
});

test("pool states distinguish cooldown and disabling from OAuth expiry", () => {
	const markup = renderToStaticMarkup(
		<AiPoolStatus
			account={{
				...account,
				pool: {
					...account.pool,
					active: 1,
					cooldownUntil: 10_000,
					lastError: "Лимит подписки исчерпан",
					status: "cooldown",
				},
			}}
		/>
	);
	expect(markup).toContain("Пауза после лимита или ошибки");
	expect(markup).toContain("1/2 активных");
	expect(markup).toContain("Лимит подписки исчерпан");
	expect(markup).not.toContain("Вход истёк");
	const disabled = renderToStaticMarkup(
		<AiPoolStatus
			account={{
				...account,
				enabled: false,
				pool: { ...account.pool, status: "disabled" },
			}}
		/>
	);
	expect(disabled).toContain("Исключён из пула");
});

test("automatic routing coexists with distinct manual accounts and excludes disabled accounts", () => {
	const markup = renderToStaticMarkup(
		<AiPlayground
			accounts={[
				account,
				{ ...account, id: "second", label: "Another subscription" },
				{
					...account,
					enabled: false,
					id: "disabled",
					label: "Excluded subscription",
				},
			]}
			providers={[provider]}
		/>
	);
	expect(markup).toContain("Автоматически из пула");
	expect(markup).toContain("Another subscription");
	expect(markup).not.toContain("Excluded subscription");
});

test("proxy SDK setup uses application keys and both supported authentication headers", () => {
	const markup = renderToStaticMarkup(
		<AiProxyAccess baseUrl="http://127.0.0.1:1234" />
	);
	expect(markup).toContain("http://127.0.0.1:1234/v1");
	expect(markup).toContain("Authorization: Bearer YOUR_DEVHUB_KEY");
	expect(markup).toContain("x-api-key: YOUR_DEVHUB_KEY");
	expect(markup.match(/max_retries=0/g)).toHaveLength(2);
	expect(markup).not.toContain("x-devhub-client");
	expect(markup).not.toContain("client-token");
});

test("key list has only a masked prefix while one-time creation explicitly asks to save the secret", () => {
	const markup = renderToStaticMarkup(
		<AiKeyRow
			onRefresh={refresh}
			record={{
				createdAt: 1000,
				enabled: true,
				id: "key-1",
				label: "Editor",
				prefix: "dhp_prefix",
				requests: 2,
			}}
		/>
	);
	expect(markup).toContain("dhp_prefix…");
	expect(markup).toContain("Отозвать");
	expect(markup).not.toContain("fixture_secret_value");
	const secret = renderToStaticMarkup(
		<AiKeySecret onHide={hideSecret} secret="fixture_secret_value" />
	);
	expect(secret).toContain("он показывается только сейчас");
	expect(secret).toContain("fixture_secret_value");
	expect(secret).toContain("Сохранён, скрыть ключ");
});

test("proxy statistics render counters without request contents", () => {
	const markup = renderToStaticMarkup(
		<AiProxyStats
			stats={{
				completed: 5,
				failed: 3,
				inputTokens: 100,
				outputTokens: 200,
				requests: 8,
			}}
		/>
	);
	expect(markup).toContain("100 / 200");
	expect(markup).toContain("Завершено");
	expect(markup).not.toContain("messages");
});

test("persisted proxy key scopes and expired status stay visible after reload", () => {
	const markup = renderToStaticMarkup(
		<AiKeyRow
			accounts={[account]}
			onRefresh={refresh}
			record={{
				allowedAccounts: [account.id],
				allowedModels: ["coding"],
				allowedProviders: ["codex"],
				createdAt: 1,
				enabled: true,
				expiresAt: 2,
				id: "restricted-key",
				label: "Restricted editor",
				prefix: "dh_public",
				requests: 3,
				requestsPerMinute: 15,
			}}
		/>
	);
	expect(markup).toContain("Срок истёк");
	expect(markup).toContain("15 запросов в минуту");
	expect(markup).toContain("Аккаунты: Personal account");
	expect(markup).toContain("Модели: coding");
	expect(markup).not.toContain("Все модели");
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

test("automatic AI stream sends provider rather than pinning an account and preserves route metadata", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		streamed([
			new TextEncoder().encode(
				'{"type":"route","accountId":"second","provider":"codex","model":"gpt-test"}\n{"type":"text","text":"Hello"}\n{"type":"done"}\n'
			),
		])
	);
	const events: AiStreamEvent[] = [];
	try {
		await aiChat(
			{
				messages: [{ content: "Test", role: "user" }],
				model: "coding",
				provider: "codex",
			},
			(event) => events.push(event),
			new AbortController().signal
		);
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
			messages: [{ content: "Test", role: "user" }],
			model: "coding",
			provider: "codex",
		});
		expect(events).toEqual([
			{
				accountId: "second",
				model: "gpt-test",
				provider: "codex",
				type: "route",
			},
			{ text: "Hello", type: "text" },
			{ type: "done" },
		]);
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
