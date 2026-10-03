import { useCallback, useEffect, useState } from "react";

import { AiProviderCard } from "./ai-accounts";
import { type AiState, aiRequest } from "./ai-api";
import { AiPlayground } from "./ai-playground";
import { AiProxy } from "./ai-proxy";

type AiTab = "subscriptions" | "proxy" | "playground";
const TABS: Record<AiTab, string> = {
	playground: "Тест моделей",
	proxy: "Прокси",
	subscriptions: "Подписки",
};
const TAB_ORDER: AiTab[] = ["subscriptions", "proxy", "playground"];

function AiTabButton({
	id,
	selected,
	onSelect,
}: {
	id: AiTab;
	selected: boolean;
	onSelect: (id: AiTab) => void;
}) {
	const select = useCallback(() => onSelect(id), [id, onSelect]);
	return (
		<button
			aria-controls={`ai-panel-${id}`}
			aria-selected={selected}
			className={`ai-tab${selected ? "ai-tab--selected" : ""}`}
			id={`ai-tab-${id}`}
			onClick={select}
			role="tab"
			type="button"
		>
			{TABS[id]}
		</button>
	);
}

export function AiPage() {
	const [state, setState] = useState<AiState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [tab, setTab] = useState<AiTab>("subscriptions");
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
					<span className="ai-eyebrow">Личные подписки · локальный прокси</span>
					<h1>Claude и Codex</h1>
					<p className="muted">
						Объедините несколько аккаунтов и вызывайте модели из приложений
						через один адрес.
					</p>
				</div>
				<button
					className="button"
					disabled={loading}
					onClick={refresh}
					type="button"
				>
					{loading ? "Обновляю…" : "Обновить"}
				</button>
			</div>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
			{state ? (
				<>
					<div aria-label="Управление AI" className="ai-tabs" role="tablist">
						{TAB_ORDER.map((id) => (
							<AiTabButton
								id={id}
								key={id}
								onSelect={setTab}
								selected={tab === id}
							/>
						))}
					</div>
					<div
						aria-labelledby="ai-tab-subscriptions"
						hidden={tab !== "subscriptions"}
						id="ai-panel-subscriptions"
						role="tabpanel"
					>
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
					</div>
					<div
						aria-labelledby="ai-tab-proxy"
						hidden={tab !== "proxy"}
						id="ai-panel-proxy"
						role="tabpanel"
					>
						<AiProxy onRefresh={refresh} state={state} />
					</div>
					<div
						aria-labelledby="ai-tab-playground"
						hidden={tab !== "playground"}
						id="ai-panel-playground"
						role="tabpanel"
					>
						<AiPlayground
							accounts={state.accounts}
							aliases={state.proxy.aliases}
							providers={state.providers}
						/>
					</div>
				</>
			) : null}
			{state || error ? null : <p className="muted">Загружаю подключения…</p>}
		</div>
	);
}
