import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";

import type { AiAccountView, AiProvider, AiProxyKeyView } from "../ai/types";
import { aiRequest } from "./ai-api";

function keyDate(value: number): string {
	return new Date(value).toLocaleString("ru-RU", {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
	});
}

export function AiKeySecret({
	secret,
	onHide,
}: {
	secret: string;
	onHide: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(secret);
			setCopied(true);
		} catch {
			setError("Буфер обмена недоступен. Выделите ключ и скопируйте вручную.");
		}
	}, [secret]);
	return (
		<div className="ai-secret" role="status">
			<strong>Сохраните ключ: он показывается только сейчас</strong>
			<label className="ai-field">
				<span>Ключ приложения</span>
				<input autoComplete="off" readOnly spellCheck={false} value={secret} />
			</label>
			<div className="ai-actions">
				<button className="button" onClick={copy} type="button">
					{copied ? "Скопировано" : "Скопировать"}
				</button>
				<button className="button" onClick={onHide} type="button">
					Сохранён, скрыть ключ
				</button>
			</div>
			{error ? <p className="ai-error">{error}</p> : null}
		</div>
	);
}

export function AiKeyRow({
	record,
	accounts = [],
	onRefresh,
}: {
	record: AiProxyKeyView;
	accounts?: AiAccountView[];
	onRefresh: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const revoke = useCallback(async () => {
		setPending(true);
		setError(null);
		try {
			await aiRequest(`proxy/keys/${encodeURIComponent(record.id)}/revoke`, {});
			await onRefresh();
		} catch (failure) {
			setError((failure as Error).message);
		} finally {
			setPending(false);
		}
	}, [record.id, onRefresh]);
	return (
		<div className="ai-key-row">
			<div>
				<strong>{record.label}</strong>
				<p className="muted small">
					<code>{record.prefix}…</code> · {record.requests} запросов ·{" "}
					{keyStatus(record)}
				</p>
				<p className="muted small">
					Создан {keyDate(record.createdAt)}
					{record.expiresAt ? ` · до ${keyDate(record.expiresAt)}` : ""}
					{record.lastUsedAt
						? ` · использован ${keyDate(record.lastUsedAt)}`
						: ""}
				</p>
				<AiKeyScope accounts={accounts} record={record} />
			</div>
			<button
				className="button button--small"
				disabled={pending || !record.enabled}
				onClick={revoke}
				type="button"
			>
				{pending ? "Отзываю…" : "Отозвать"}
			</button>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}

function keyStatus(record: AiProxyKeyView): string {
	if (!record.enabled) {
		return "Отозван";
	}
	return record.expiresAt && record.expiresAt <= Date.now()
		? "Срок истёк"
		: "Активен";
}

function AiKeyScope({
	record,
	accounts,
}: {
	record: AiProxyKeyView;
	accounts: AiAccountView[];
}) {
	const providers =
		record.allowedProviders
			?.map((provider) => (provider === "codex" ? "OpenAI" : "Claude"))
			.join(", ") ?? "Оба провайдера";
	const scopedAccounts =
		record.allowedAccounts
			?.map((id) => accounts.find((account) => account.id === id)?.label ?? id)
			.join(", ") ?? "Весь доступный пул";
	return (
		<div className="muted small ai-key-scope">
			<span>
				{providers} ·{" "}
				{record.requestsPerMinute
					? `${record.requestsPerMinute} запросов в минуту`
					: "Без ограничения темпа"}
			</span>
			<span>Аккаунты: {scopedAccounts}</span>
			<span>Модели: {record.allowedModels?.join(", ") ?? "Все модели"}</span>
		</div>
	);
}

function keyOptions(fields: FormData) {
	const provider = String(fields.get("provider"));
	const accountId = String(fields.get("accountId"));
	const models = String(fields.get("models") ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const days = Number(fields.get("days"));
	return {
		allowedAccounts: accountId ? [accountId] : undefined,
		allowedModels: models.length ? models : undefined,
		allowedProviders: provider ? [provider as AiProvider] : undefined,
		expiresAt: days ? Date.now() + days * 86_400_000 : undefined,
		label: String(fields.get("label") ?? "").trim(),
		requestsPerMinute: Number(fields.get("requestsPerMinute")),
	};
}

export function AiProxyKeys({
	records,
	accounts,
	onRefresh,
}: {
	records: AiProxyKeyView[];
	accounts: AiAccountView[];
	onRefresh: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [providerScope, setProviderScope] = useState<AiProvider | "">("");
	const locked = pending || secret !== null;
	const editProvider = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			setProviderScope(event.currentTarget.value as AiProvider | ""),
		[]
	);
	const hide = useCallback(() => setSecret(null), []);
	const create = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const form = event.currentTarget;
			const options = keyOptions(new FormData(form));
			setPending(true);
			setError(null);
			try {
				const result = await aiRequest<{ key: string; record: AiProxyKeyView }>(
					"proxy/keys",
					options
				);
				setSecret(result.key);
				form.reset();
				setProviderScope("");
				await onRefresh();
			} catch (failure) {
				setError((failure as Error).message);
			} finally {
				setPending(false);
			}
		},
		[onRefresh]
	);
	return (
		<section aria-label="Ключи приложений" className="ai-provider">
			<h2>Ключи приложений</h2>
			<p className="muted">
				Отдельный ключ для каждого клиента. Он разрешает только вызовы моделей
				через прокси.
			</p>
			{secret ? <AiKeySecret onHide={hide} secret={secret} /> : null}
			<form className="ai-config-form" onSubmit={create}>
				<label className="ai-field">
					<span>Название приложения</span>
					<input
						disabled={locked}
						maxLength={120}
						name="label"
						placeholder="Например, Cursor"
						required
					/>
				</label>
				<details className="ai-settings">
					<summary>Ограничения ключа</summary>
					<div className="ai-config-numbers">
						<label className="ai-field">
							<span>Провайдер</span>
							<select
								disabled={locked}
								name="provider"
								onChange={editProvider}
								value={providerScope}
							>
								<option value="">Оба провайдера</option>
								<option value="codex">OpenAI</option>
								<option value="claude">Claude</option>
							</select>
						</label>
						<label className="ai-field">
							<span>Срок</span>
							<select defaultValue="30" disabled={locked} name="days">
								<option value="7">7 дней</option>
								<option value="30">30 дней</option>
								<option value="90">90 дней</option>
								<option value="0">Без срока</option>
							</select>
						</label>
						<label className="ai-field">
							<span>Запросов в минуту</span>
							<input
								defaultValue={60}
								disabled={locked}
								max={10_000}
								min={1}
								name="requestsPerMinute"
								required
								type="number"
							/>
						</label>
					</div>
					<label className="ai-field">
						<span>Доступ к аккаунтам</span>
						<select disabled={locked} key={providerScope} name="accountId">
							<option value="">Весь доступный пул</option>
							{accounts
								.filter(
									(account) =>
										!providerScope || account.provider === providerScope
								)
								.map((account) => (
									<option key={account.id} value={account.id}>
										{account.provider} · {account.label}
									</option>
								))}
						</select>
					</label>
					<label className="ai-field">
						<span>Доступные модели и псевдонимы через запятую</span>
						<input
							disabled={locked}
							name="models"
							placeholder="Пусто — все модели; например, coding, claude/claude-sonnet-4-6"
						/>
					</label>
				</details>
				<button
					className="button button--primary"
					disabled={locked}
					type="submit"
				>
					{pending ? "Создаю…" : "Создать ключ"}
				</button>
			</form>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
			<div className="ai-key-list">
				{records.length ? (
					records.map((record) => (
						<AiKeyRow
							accounts={accounts}
							key={record.id}
							onRefresh={onRefresh}
							record={record}
						/>
					))
				) : (
					<p className="muted">
						Создайте ключ и укажите его в настройках приложения.
					</p>
				)}
			</div>
		</section>
	);
}
