import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";

import type {
	AiAccountView,
	AiModelAlias,
	AiProvider,
	AiState,
} from "../ai/types";
import { aiRequest } from "./ai-api";
import { AiProxyKeys } from "./ai-proxy-keys";

type ProxyView = AiState["proxy"];
const STRATEGIES = {
	"fill-first": "Сначала основной аккаунт",
	"least-busy": "Наименее загруженный",
	"round-robin": "По очереди с учётом веса",
};

export function AiProxyAccess({ baseUrl }: { baseUrl: string }) {
	return (
		<section aria-label="Подключение приложений" className="ai-provider">
			<h2>Подключение приложений</h2>
			<p className="muted">
				Укажите адрес прокси и созданный ниже ключ в настройках вашего клиента.
			</p>
			<dl className="ai-endpoints">
				<dt>OpenAI Base URL</dt>
				<dd>
					<code>{baseUrl}/v1</code>
				</dd>
				<dt>Anthropic Base URL</dt>
				<dd>
					<code>{baseUrl}</code>
				</dd>
			</dl>
			<p className="muted small">
				Модель: <code>codex/имя-модели</code>, <code>claude/имя-модели</code>{" "}
				или ваш псевдоним. Доступные модели: <code>GET /v1/models</code>; для
				принудительного обновления — <code>GET /v1/models?refresh=1</code>.
			</p>
			<details className="ai-settings">
				<summary>Примеры для SDK и HTTP</summary>
				<pre className="ai-code">{`from openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl}/v1", api_key="YOUR_DEVHUB_KEY", max_retries=0)\n# client.responses.create(model="coding", input="Hello")`}</pre>
				<pre className="ai-code">{`from anthropic import Anthropic\n\nclient = Anthropic(base_url="${baseUrl}", api_key="YOUR_DEVHUB_KEY", max_retries=0)\n# client.messages.create(model="writing", max_tokens=1024,\n#                        messages=[{"role": "user", "content": "Hello"}])`}</pre>
				<p className="muted small">
					Замените coding и writing на созданный псевдоним или имя модели.
					Автоповтор SDK отключён; оборванный запрос можно повторить вручную.
				</p>
				<p className="muted small">
					OpenAI SDK отправляет{" "}
					<code>Authorization: Bearer YOUR_DEVHUB_KEY</code>; Anthropic SDK —{" "}
					<code>x-api-key: YOUR_DEVHUB_KEY</code>. Ключи подписок остаются в
					DevHub.
				</p>
			</details>
		</section>
	);
}

export function AiProxyStats({ stats }: { stats: ProxyView["stats"] }) {
	return (
		<section aria-label="Статистика прокси" className="ai-stats">
			<div>
				<strong>{stats.requests}</strong>
				<span>Запросов</span>
			</div>
			<div>
				<strong>{stats.completed}</strong>
				<span>Завершено</span>
			</div>
			<div>
				<strong>{stats.failed}</strong>
				<span>Ошибок</span>
			</div>
			<div>
				<strong>
					{stats.inputTokens} / {stats.outputTokens}
				</strong>
				<span>Токены вход / выход</span>
			</div>
		</section>
	);
}

function aliasData(form: HTMLFormElement): AiModelAlias {
	const fields = new FormData(form);
	const accountId = String(fields.get("accountId") ?? "");
	return {
		id: String(fields.get("id") ?? "").trim(),
		model: String(fields.get("model") ?? "").trim(),
		provider: String(fields.get("provider")) as AiProvider,
		...(accountId ? { accountId } : {}),
	};
}

function AiAliasForm({
	alias,
	accounts,
	pending,
	onSave,
}: {
	alias?: AiModelAlias;
	accounts: AiAccountView[];
	pending: boolean;
	onSave: (value: AiModelAlias) => Promise<void>;
}) {
	const [provider, setProvider] = useState<AiProvider>(
		alias?.provider ?? "codex"
	);
	const editProvider = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			setProvider(event.currentTarget.value as AiProvider),
		[]
	);
	const submit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			await onSave(aliasData(event.currentTarget));
		},
		[onSave]
	);
	return (
		<form className="ai-config-form" onSubmit={submit}>
			<div className="ai-alias-fields">
				<label className="ai-field">
					<span>Псевдоним модели</span>
					<input
						defaultValue={alias?.id}
						disabled={pending}
						maxLength={120}
						name="id"
						pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
						placeholder="coding"
						required
					/>
				</label>
				<label className="ai-field">
					<span>Провайдер</span>
					<select
						disabled={pending}
						name="provider"
						onChange={editProvider}
						value={provider}
					>
						<option value="codex">OpenAI</option>
						<option value="claude">Claude</option>
					</select>
				</label>
				<label className="ai-field">
					<span>Модель провайдера</span>
					<input
						defaultValue={alias?.model}
						disabled={pending}
						maxLength={200}
						name="model"
						pattern="[^/]+"
						placeholder="Имя модели без префикса"
						required
					/>
				</label>
			</div>
			<label className="ai-field">
				<span>Маршрут</span>
				<select
					defaultValue={alias?.accountId ?? ""}
					disabled={pending}
					key={provider}
					name="accountId"
				>
					<option value="">
						Автоматически из пула {provider === "codex" ? "OpenAI" : "Claude"}
					</option>
					{accounts
						.filter((account) => account.provider === provider)
						.map((account) => (
							<option key={account.id} value={account.id}>
								{account.label}
							</option>
						))}
				</select>
			</label>
			<button className="button button--small" disabled={pending} type="submit">
				{pending ? "Сохраняю…" : "Сохранить псевдоним"}
			</button>
		</form>
	);
}

function AiAliasRow({
	alias,
	accounts,
	pending,
	onRemove,
	onSave,
}: {
	alias: AiModelAlias;
	accounts: AiAccountView[];
	pending: boolean;
	onRemove: (id: string) => Promise<void>;
	onSave: (value: AiModelAlias, previous?: string) => Promise<void>;
}) {
	const remove = useCallback(() => onRemove(alias.id), [alias.id, onRemove]);
	const save = useCallback(
		(value: AiModelAlias) => onSave(value, alias.id),
		[alias.id, onSave]
	);
	const account = accounts.find((entry) => entry.id === alias.accountId);
	return (
		<div className="ai-alias-row">
			<div className="ai-account__head">
				<strong>
					<code>{alias.id}</code>
				</strong>
				<button
					className="button button--small"
					disabled={pending}
					onClick={remove}
					type="button"
				>
					Удалить
				</button>
			</div>
			<p className="muted small">
				{alias.provider}/{alias.model} ·{" "}
				{alias.accountId
					? (account?.label ?? "Аккаунт недоступен")
					: "Автоматический пул"}
			</p>
			<details className="ai-account-settings">
				<summary>Изменить маршрут</summary>
				<AiAliasForm
					accounts={accounts}
					alias={alias}
					key={`${alias.id}:${alias.provider}:${alias.model}:${alias.accountId ?? ""}`}
					onSave={save}
					pending={pending}
				/>
			</details>
		</div>
	);
}

function AiProxyRouting({
	proxy,
	accounts,
	onRefresh,
}: {
	proxy: ProxyView;
	accounts: AiAccountView[];
	onRefresh: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const saveConfig = useCallback(
		async (selection: ProxyView["strategy"], aliases: AiModelAlias[]) => {
			setPending(true);
			setError(null);
			try {
				await aiRequest("proxy/config", { aliases, strategy: selection });
				await onRefresh();
			} catch (failure) {
				setError((failure as Error).message);
			} finally {
				setPending(false);
			}
		},
		[onRefresh]
	);
	const strategy = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			saveConfig(
				event.currentTarget.value as ProxyView["strategy"],
				proxy.aliases
			),
		[proxy.aliases, saveConfig]
	);
	const saveAlias = useCallback(
		async (alias: AiModelAlias, previous?: string) => {
			if (
				proxy.aliases.some(
					(entry) => entry.id === alias.id && entry.id !== previous
				)
			) {
				setError("Псевдоним уже существует. Измените его в списке ниже.");
				return;
			}
			await saveConfig(proxy.strategy, [
				...proxy.aliases.filter((entry) => entry.id !== previous),
				alias,
			]);
		},
		[proxy.aliases, proxy.strategy, saveConfig]
	);
	const removeAlias = useCallback(
		(id: string) =>
			saveConfig(
				proxy.strategy,
				proxy.aliases.filter((entry) => entry.id !== id)
			),
		[proxy.aliases, proxy.strategy, saveConfig]
	);
	return (
		<section aria-label="Маршрутизация" className="ai-provider">
			<h2>Маршрутизация</h2>
			<label className="ai-field">
				<span>Выбор аккаунта</span>
				<select disabled={pending} onChange={strategy} value={proxy.strategy}>
					{Object.entries(STRATEGIES).map(([id, name]) => (
						<option key={id} value={id}>
							{name}
						</option>
					))}
				</select>
			</label>
			<p className="muted small">
				Сначала доступны аккаунты с большим приоритетом. При лимите или ошибке
				прокси пробует следующий до начала ответа.
			</p>
			<div className="ai-alias-list">
				{proxy.aliases.map((alias) => (
					<AiAliasRow
						accounts={accounts}
						alias={alias}
						key={alias.id}
						onRemove={removeAlias}
						onSave={saveAlias}
						pending={pending}
					/>
				))}
			</div>
			<details className="ai-settings">
				<summary>Добавить псевдоним модели</summary>
				<p className="muted small">
					Стабильное имя для приложений. Например, coding или writing; менять
					модель можно здесь.
				</p>
				<AiAliasForm accounts={accounts} onSave={saveAlias} pending={pending} />
			</details>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
}

export function AiProxy({
	state,
	onRefresh,
}: {
	state: AiState;
	onRefresh: () => Promise<void>;
}) {
	const baseUrl =
		typeof window === "undefined"
			? "http://127.0.0.1:3100"
			: window.location.origin;
	return (
		<div className="ai-proxy">
			<AiProxyStats stats={state.proxy.stats} />
			<AiProxyAccess baseUrl={baseUrl} />
			<div className="ai-proxy-grid">
				<AiProxyRouting
					accounts={state.accounts}
					onRefresh={onRefresh}
					proxy={state.proxy}
				/>
				<AiProxyKeys
					accounts={state.accounts}
					onRefresh={onRefresh}
					records={state.proxy.keys}
				/>
			</div>
			<p className="muted small">
				Статистика с текущего запуска DevHub обновляется кнопкой «Обновить».
				Тексты диалогов и ключи подписок в статистику не попадают.
			</p>
		</div>
	);
}
