import { useCallback, useEffect, useState } from "react";

import { AiProviderCard } from "./ai-accounts";
import { type AiState, aiRequest } from "./ai-api";
import { AiPlayground } from "./ai-playground";

export function AiPage() {
	const [state, setState] = useState<AiState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setState(await aiRequest<AiState>("state"));
		} catch (failure) {
			setError((failure as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		aiRequest<AiState>("state", undefined, controller.signal)
			.then((next) => {
				if (!controller.signal.aborted) {
					setState(next);
				}
			})
			.catch((failure: Error) => {
				if (!controller.signal.aborted) {
					setError(failure.message);
				}
			});
		return () => controller.abort();
	}, []);
	return (
		<div className="ai-page">
			<div className="ai-page__head">
				<div>
					<span className="ai-eyebrow">Личные подписки</span>
					<h1>Claude и Codex</h1>
					<p className="muted">
						Подключите свой аккаунт и вызывайте модели из DevHub или локальных
						приложений.
					</p>
				</div>
				<button
					className="button"
					disabled={loading}
					onClick={refresh}
					type="button"
				>
					{loading ? "Обновляю…" : "Обновить подключения"}
				</button>
			</div>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
			{state ? (
				<>
					<div className="ai-providers">
						{state.providers.map((provider) => (
							<AiProviderCard
								accounts={state.accounts.filter(
									(account) => account.provider === provider.id
								)}
								key={provider.id}
								onRefresh={refresh}
								provider={provider}
							/>
						))}
					</div>
					<AiPlayground accounts={state.accounts} providers={state.providers} />
					<details className="ai-api-note">
						<summary>Вызов из локальных приложений</summary>
						<p>
							Отправляйте JSON в <code>POST /api/ai/chat</code> на адрес этого
							пульта. Укажите <code>accountId</code>, <code>model</code> и{" "}
							<code>messages</code>. Ответ передаётся потоком NDJSON.
						</p>
						<p className="muted">
							Для локального клиента используйте заголовок{" "}
							<code>x-devhub-client</code> с ключом из{" "}
							<code>.state/client-token</code> в основной папке DevHub. Ключи
							подписок остаются на сервере.
						</p>
					</details>
				</>
			) : null}
			{state || error ? null : <p className="muted">Загружаю подключения…</p>}
		</div>
	);
}
