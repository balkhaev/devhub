import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
	AiAccountView,
	AiAvailableModel,
	AiModelsInventory,
	AiProviderView,
} from "../ai/types";
import { aiModels } from "./ai-api";
import {
	AiAvailableModelRow,
	AiModelDiagnostics,
	AiModelReference,
	AiModelsPanel,
} from "./ai-models";
import { AiPlayground, aiPlaygroundModels } from "./ai-playground";

const refresh = async () => undefined;
const select = () => undefined;
const account: AiAccountView = {
	enabled: true,
	id: "first",
	label: "First subscription",
	maxConcurrency: 2,
	pool: {
		active: 0,
		completed: 0,
		failed: 0,
		inputTokens: 0,
		outputTokens: 0,
		requests: 0,
		status: "ready",
	},
	priority: 0,
	provider: "codex",
	source: "oauth",
	status: "connected",
	weight: 1,
};
const second: AiAccountView = {
	...account,
	id: "second",
	label: "Second subscription",
};
const provider: AiProviderView = {
	description: "Personal subscriptions",
	id: "codex",
	models: [{ id: "gpt-reference", name: "Unconfirmed reference model" }],
	name: "OpenAI",
};
const model: AiAvailableModel = {
	accountIds: [second.id],
	available: true,
	id: "codex/gpt-only-second",
	kind: "pool",
	model: "gpt-only-second",
	name: "Only on second account",
	provider: "codex",
	source: "remote",
};
const inventory: AiModelsInventory = {
	accounts: [
		{
			accountId: account.id,
			error: "Не удалось получить список моделей",
			modelCount: 0,
			provider: "codex",
			source: "unavailable",
		},
		{
			accountId: second.id,
			checkedAt: 10_000,
			modelCount: 1,
			provider: "codex",
			source: "remote",
		},
	],
	models: [
		model,
		{ ...model, id: "second/gpt-only-second", kind: "account" },
		{ ...model, id: "coding", kind: "alias", source: "cache" },
	],
	updatedAt: 10_000,
};

test("available models panel shows provider, account and alias route IDs separately from the unconfirmed reference", () => {
	const markup = renderToStaticMarkup(
		<AiModelsPanel
			accounts={[account, second]}
			inventory={{ data: inventory, error: null, loading: false, refresh }}
			onSelect={select}
			providers={[provider]}
		/>
	);
	expect(markup).toContain("Доступные модели");
	expect(markup).toContain("codex/gpt-only-second");
	expect(markup).toContain("second/gpt-only-second");
	expect(markup).toContain("coding");
	expect(markup).toContain("Скопировать codex/gpt-only-second");
	expect(markup).toContain("Second subscription");
	expect(markup).toContain("Свежий кэш");
	expect(markup).toContain("Справочник моделей — доступность не подтверждена");
});

test("automatic playground includes confirmed models from a later account and never treats reference catalogue as availability", () => {
	const markup = renderToStaticMarkup(
		<AiPlayground
			accounts={[account, second]}
			inventory={inventory}
			onModelsRefresh={refresh}
			providers={[provider]}
		/>
	);
	expect(markup).toContain("Only on second account");
	expect(markup).toContain('value="codex/gpt-only-second" selected=""');
	expect(markup).toContain('value="coding"');
	expect(markup).not.toContain('value="second/gpt-only-second"');
	expect(markup).not.toContain("Unconfirmed reference model");
	expect(markup).toContain("Модель подтверждена подписками: 1");
});

test("explicit account model selection and pinned aliases respect their inventory account scope", () => {
	expect(aiPlaygroundModels(inventory, "codex", account.id)).toEqual([]);
	expect(
		aiPlaygroundModels(inventory, "codex", second.id).map((entry) => entry.id)
	).toEqual(["second/gpt-only-second", "coding"]);
	expect(aiPlaygroundModels(inventory, "claude")).toEqual([]);
	const pinned = inventory.models.find((entry) => entry.kind === "account");
	const markup = renderToStaticMarkup(
		<AiPlayground
			accounts={[account, second]}
			initialSelection={pinned}
			inventory={inventory}
			onModelsRefresh={refresh}
			providers={[provider]}
		/>
	);
	expect(markup).toContain('value="second" selected=""');
	expect(markup).toContain('value="second/gpt-only-second" selected=""');
});

test("stale model routes stay identifiable but cannot be tested as currently available", () => {
	const stale = { ...model, available: false, source: "stale" as const };
	const markup = renderToStaticMarkup(
		<table>
			<tbody>
				<AiAvailableModelRow
					accounts={[account, second]}
					model={stale}
					onSelect={select}
				/>
			</tbody>
		</table>
	);
	expect(markup).toContain("Устаревший список");
	expect(markup).toContain("Доступность сейчас не подтверждена");
	expect(markup).toContain('disabled=""');
	expect(markup).toContain("codex/gpt-only-second");
	const playground = renderToStaticMarkup(
		<AiPlayground
			accounts={[account, second]}
			inventory={{ ...inventory, models: [stale] }}
			providers={[provider]}
		/>
	);
	expect(playground).toContain(
		"Устаревший список — доступность не подтверждена"
	);
	expect(playground).toContain("Справочник — доступность не подтверждена");
	expect(playground).toContain("Выбрано имя из справочника.");
	expect(playground).not.toContain("Модель подтверждена подписками");
});

test("per-account unavailable diagnostics stay text and the reference is explicitly unconfirmed", () => {
	const markup = renderToStaticMarkup(
		<AiModelDiagnostics
			accounts={[account]}
			views={[
				{
					accountId: account.id,
					error: "<script>fixture</script>",
					modelCount: 0,
					provider: "codex",
					source: "unavailable",
				},
			]}
		/>
	);
	expect(markup).toContain("Список недоступен");
	expect(markup).toContain("First subscription");
	expect(markup).not.toContain("<script>");
	expect(markup).toContain("&lt;script&gt;");
	const reference = renderToStaticMarkup(
		<AiModelReference providers={[provider]} />
	);
	expect(reference).toContain("не входят в список доступных моделей API");
	expect(reference).toContain("codex/gpt-reference");
});

test("empty inventory directs missing, disabled and expired subscriptions to the correct connection actions", () => {
	const emptyInventory = {
		data: { accounts: [], models: [], updatedAt: 10_000 },
		error: null,
		loading: false,
		refresh,
	};
	const missing = renderToStaticMarkup(
		<AiModelsPanel
			accounts={[]}
			inventory={emptyInventory}
			onSelect={select}
			providers={[provider]}
		/>
	);
	expect(missing).toContain(
		"Подключите подписку во вкладке «Подписки», чтобы получить доступные модели."
	);
	expect(missing).not.toContain("Проверьте состояние аккаунтов ниже");
	const unavailable = renderToStaticMarkup(
		<AiModelsPanel
			accounts={[
				{ ...account, enabled: false },
				{ ...second, status: "expired" },
			]}
			inventory={emptyInventory}
			onSelect={select}
			providers={[provider]}
		/>
	);
	expect(unavailable).toContain(
		"Включите подписку или выполните повторный вход во вкладке «Подписки»"
	);
	expect(unavailable).not.toContain("Проверьте состояние аккаунтов ниже");
});

test("inventory refresh calls the shared models endpoint with the browser guard, no cache and cancellation", async () => {
	const fetcher = spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(Response.json(inventory))
		.mockResolvedValueOnce(Response.json(inventory));
	const { signal } = new AbortController();
	try {
		expect(await aiModels(true, signal)).toEqual(inventory);
		expect(fetcher.mock.calls[0]?.[0]).toBe("/api/ai/models?refresh=1");
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			cache: "no-store",
			headers: { "Content-Type": "application/json", "x-devhub": "1" },
			method: "GET",
			signal,
		});
		await aiModels();
		expect(fetcher.mock.calls[1]?.[0]).toBe("/api/ai/models");
	} finally {
		fetcher.mockRestore();
	}
});
