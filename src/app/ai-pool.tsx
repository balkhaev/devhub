import { type FormEvent, useCallback, useState } from "react";

import type { AiAccountView } from "../ai/types";
import { aiRequest } from "./ai-api";

const POOL_NAMES = {
	cooldown: "Пауза после лимита или ошибки",
	disabled: "Исключён из пула",
	ready: "Готов к маршрутизации",
	unauthorized: "Нужен повторный вход",
};

export function AiPoolStatus({ account }: { account: AiAccountView }) {
	const { pool } = account;
	return (
		<div className="ai-pool-status">
			<span className={`ai-status ai-status--${pool.status}`}>
				{POOL_NAMES[pool.status]}
			</span>
			<span className="muted small">
				{pool.active}/{account.maxConcurrency} активных · {pool.completed}{" "}
				завершено · {pool.failed} ошибок
			</span>
			{pool.cooldownUntil ? (
				<span className="muted small">
					Следующая попытка после{" "}
					{new Date(pool.cooldownUntil).toLocaleTimeString("ru-RU")}
				</span>
			) : null}
			{pool.lastError ? (
				<span className="muted small">{pool.lastError}</span>
			) : null}
		</div>
	);
}

export function AiPoolControls({
	account,
	onRefresh,
}: {
	account: AiAccountView;
	onRefresh: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const fields = new FormData(event.currentTarget);
			setPending(true);
			setError(null);
			try {
				await aiRequest(`accounts/${encodeURIComponent(account.id)}/config`, {
					enabled: fields.has("enabled"),
					label: String(fields.get("label") ?? "").trim(),
					maxConcurrency: Number(fields.get("maxConcurrency")),
					priority: Number(fields.get("priority")),
					weight: Number(fields.get("weight")),
				});
				await onRefresh();
			} catch (failure) {
				setError((failure as Error).message);
			} finally {
				setPending(false);
			}
		},
		[account.id, onRefresh]
	);
	return (
		<details className="ai-account-settings">
			<summary>Настроить аккаунт и пул</summary>
			<form
				className="ai-config-form"
				key={`${account.label}:${account.enabled}:${account.priority}:${account.weight}:${account.maxConcurrency}`}
				onSubmit={save}
			>
				<label className="ai-check">
					<input
						defaultChecked={account.enabled}
						disabled={pending}
						name="enabled"
						type="checkbox"
					/>{" "}
					Использовать в прокси
				</label>
				<label className="ai-field">
					<span>Название</span>
					<input
						defaultValue={account.label}
						disabled={pending}
						maxLength={120}
						name="label"
						required
					/>
				</label>
				<div className="ai-config-numbers">
					<label className="ai-field">
						<span>Приоритет</span>
						<input
							defaultValue={account.priority}
							disabled={pending}
							max={100}
							min={-100}
							name="priority"
							required
							type="number"
						/>
					</label>
					<label className="ai-field">
						<span>Вес</span>
						<input
							defaultValue={account.weight}
							disabled={pending}
							max={100}
							min={1}
							name="weight"
							required
							type="number"
						/>
					</label>
					<label className="ai-field">
						<span>Параллельных запросов</span>
						<input
							defaultValue={account.maxConcurrency}
							disabled={pending}
							max={32}
							min={1}
							name="maxConcurrency"
							required
							type="number"
						/>
					</label>
				</div>
				<p className="muted small">
					Больший приоритет выбирается первым. Вес распределяет запросы между
					аккаунтами одного приоритета.
				</p>
				<button
					className="button button--small"
					disabled={pending}
					type="submit"
				>
					{pending ? "Сохраняю…" : "Сохранить"}
				</button>
			</form>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
		</details>
	);
}
