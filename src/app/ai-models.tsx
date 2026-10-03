import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type {
	AiAccountModelView,
	AiAccountView,
	AiAvailableModel,
	AiModelSource,
	AiModelsInventory,
	AiProviderView,
} from "../ai/types";
import { aiModels } from "./ai-api";

const SOURCE_LABELS: Record<AiModelSource, string> = {
	cache: "Свежий кэш",
	remote: "От провайдера",
	stale: "Устаревший список",
	unavailable: "Список недоступен",
};
const KIND_LABELS: Record<AiAvailableModel["kind"], string> = {
	account: "Конкретный аккаунт",
	alias: "Псевдоним",
	pool: "Автоматический пул",
};

export interface AiModelsState {
	data: AiModelsInventory | null;
	error: string | null;
	loading: boolean;
	refresh: () => Promise<void>;
}

/** One shared snapshot serves the inventory and the playground; never query just the first account. */
export function useAiModels(scope: string | null): AiModelsState {
	const [data, setData] = useState<AiModelsInventory | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const request = useRef<AbortController | null>(null);
	const load = useCallback(
		async (forceRefresh: boolean, controller: AbortController) => {
			setLoading(true);
			setError(null);
			try {
				const next = await aiModels(forceRefresh, controller.signal);
				if (!controller.signal.aborted) {
					setData(next);
				}
			} catch (failure) {
				if (!controller.signal.aborted) {
					setError((failure as Error).message);
				}
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			}
		},
		[]
	);
	useEffect(() => {
		if (scope === null) {
			return;
		}
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setData(null);
		load(false, controller).catch(() => undefined);
		return () => controller.abort();
	}, [scope, load]);
	const refresh = useCallback(async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		await load(true, controller);
	}, [load]);
	useEffect(() => () => request.current?.abort(), []);
	return { data, error, loading, refresh };
}

function checkedTime(value: number): string {
	return new Date(value).toLocaleString("ru-RU", {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
	});
}

export function AiModelSourceBadge({ source }: { source: AiModelSource }) {
	return (
		<span className={`ai-model-source ai-model-source--${source}`}>
			{SOURCE_LABELS[source]}
		</span>
	);
}

function AiModelCopy({ id }: { id: string }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(id);
			setCopied(true);
			setError(null);
		} catch {
			setError("Выделите идентификатор и скопируйте вручную.");
		}
	}, [id]);
	return (
		<div className="ai-model-id">
			<code>{id}</code>
			<button
				aria-label={`Скопировать ${id}`}
				className="button button--small"
				onClick={copy}
				type="button"
			>
				{copied ? "Скопировано" : "Копировать"}
			</button>
			{error ? <span className="muted small">{error}</span> : null}
		</div>
	);
}

export function AiAvailableModelRow({
	model,
	accounts,
	onSelect,
}: {
	model: AiAvailableModel;
	accounts: AiAccountView[];
	onSelect: (model: AiAvailableModel) => void;
}) {
	const select = useCallback(() => onSelect(model), [model, onSelect]);
	const labels = model.accountIds.map(
		(id) => accounts.find((account) => account.id === id)?.label ?? id
	);
	return (
		<tr className={model.available ? "" : "ai-model-row--stale"}>
			<td>
				<strong>{model.name}</strong>
				<AiModelCopy id={model.id} />
				<span className="muted small">
					{KIND_LABELS[model.kind]} ·{" "}
					{model.provider === "codex" ? "OpenAI" : "Claude"}
				</span>
			</td>
			<td>
				<AiModelSourceBadge source={model.source} />
				{model.available ? null : (
					<p className="muted small">Доступность сейчас не подтверждена</p>
				)}
			</td>
			<td>
				<span className="small">{labels.join(", ")}</span>
			</td>
			<td>
				<button
					className="button button--small"
					disabled={!model.available}
					onClick={select}
					type="button"
				>
					Проверить
				</button>
			</td>
		</tr>
	);
}

export function AiModelDiagnostics({
	views,
	accounts,
}: {
	views: AiAccountModelView[];
	accounts: AiAccountView[];
}) {
	return (
		<details className="ai-api-note ai-model-diagnostics">
			<summary>Получение моделей по аккаунтам</summary>
			<div className="ai-diagnostics-list">
				{views.map((view) => (
					<div className="ai-model-diagnostic" key={view.accountId}>
						<div className="ai-account__head">
							<strong>
								{accounts.find((account) => account.id === view.accountId)
									?.label ?? view.accountId}
							</strong>
							<AiModelSourceBadge source={view.source} />
						</div>
						<p className="muted small">
							{view.modelCount} моделей
							{view.checkedAt
								? ` · проверено ${checkedTime(view.checkedAt)}`
								: ""}
						</p>
						{view.error ? <p className="ai-error">{view.error}</p> : null}
					</div>
				))}
			</div>
		</details>
	);
}

export function AiModelReference({
	providers,
}: {
	providers: AiProviderView[];
}) {
	return (
		<details className="ai-api-note ai-model-reference">
			<summary>Справочник моделей — доступность не подтверждена</summary>
			<p className="muted small">
				Это встроенные имена моделей. Они не подтверждают доступ вашей подписки
				и не входят в список доступных моделей API.
			</p>
			<div className="ai-reference-grid">
				{providers.map((provider) => (
					<div key={provider.id}>
						<strong>{provider.name}</strong>
						<ul>
							{provider.models.map((model) => (
								<li key={model.id}>
									<span>{model.name}</span>
									<code>
										{provider.id}/{model.id}
									</code>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</details>
	);
}

function modelMatches(
	model: AiAvailableModel,
	query: string,
	provider: string,
	kind: string
): boolean {
	return (
		(!provider || model.provider === provider) &&
		(!kind || model.kind === kind) &&
		`${model.id} ${model.name} ${model.model}`
			.toLocaleLowerCase("ru-RU")
			.includes(query.toLocaleLowerCase("ru-RU"))
	);
}

function emptyModelsText(accounts: AiAccountView[], loading: boolean): string {
	if (!accounts.length) {
		return "Подключите подписку во вкладке «Подписки», чтобы получить доступные модели.";
	}
	if (
		!accounts.some(
			(account) => account.enabled && account.status === "connected"
		)
	) {
		return "Включите подписку или выполните повторный вход во вкладке «Подписки», чтобы получить доступные модели.";
	}
	if (loading) {
		return "Проверяю модели подключённых подписок…";
	}
	return "Подтверждённых моделей для выбранного фильтра нет. Проверьте состояние аккаунтов ниже или обновите список.";
}

export function AiModelsPanel({
	inventory,
	accounts,
	providers,
	onSelect,
}: {
	inventory: AiModelsState;
	accounts: AiAccountView[];
	providers: AiProviderView[];
	onSelect: (model: AiAvailableModel) => void;
}) {
	const [query, setQuery] = useState("");
	const [provider, setProvider] = useState("");
	const [kind, setKind] = useState("");
	const editQuery = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setQuery(event.currentTarget.value),
		[]
	);
	const editProvider = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			setProvider(event.currentTarget.value),
		[]
	);
	const editKind = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			setKind(event.currentTarget.value),
		[]
	);
	const models =
		inventory.data?.models.filter((model) =>
			modelMatches(model, query, provider, kind)
		) ?? [];
	return (
		<section aria-label="Доступные модели" className="ai-models">
			<div className="ai-section-head">
				<div>
					<h2>Доступные модели</h2>
					<p className="muted">
						DevHub получает список от всех включённых подписок. Идентификаторы
						можно передавать в SDK и API прокси.
					</p>
				</div>
				<button
					className="button"
					disabled={inventory.loading}
					onClick={inventory.refresh}
					type="button"
				>
					{inventory.loading ? "Получаю модели…" : "Обновить у провайдеров"}
				</button>
			</div>
			<p className="muted small">
				Список подтверждает наличие модели у провайдера. Текущие лимиты и
				загрузка аккаунтов учитываются при запросе.
				{inventory.data
					? ` Получено ${checkedTime(inventory.data.updatedAt)}.`
					: ""}
			</p>
			{inventory.error ? (
				<p className="ai-error" role="alert">
					{inventory.error}
				</p>
			) : null}
			<div className="ai-model-filters">
				<label className="ai-field">
					<span>Поиск</span>
					<input
						onChange={editQuery}
						placeholder="Имя или идентификатор модели"
						value={query}
					/>
				</label>
				<label className="ai-field">
					<span>Провайдер</span>
					<select onChange={editProvider} value={provider}>
						<option value="">Все провайдеры</option>
						<option value="codex">OpenAI</option>
						<option value="claude">Claude</option>
					</select>
				</label>
				<label className="ai-field">
					<span>Маршрут</span>
					<select onChange={editKind} value={kind}>
						<option value="">Все маршруты</option>
						<option value="pool">Автоматический пул</option>
						<option value="account">Конкретный аккаунт</option>
						<option value="alias">Псевдонимы</option>
					</select>
				</label>
			</div>
			{models.length ? (
				<div className="ai-model-table-wrap">
					<table className="ai-model-table">
						<thead>
							<tr>
								<th scope="col">Модель и ID для API</th>
								<th scope="col">Источник</th>
								<th scope="col">Подписки</th>
								<th scope="col">Тест</th>
							</tr>
						</thead>
						<tbody>
							{models.map((model) => (
								<AiAvailableModelRow
									accounts={accounts}
									key={model.id}
									model={model}
									onSelect={onSelect}
								/>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="ai-models-empty muted">
					{emptyModelsText(accounts, inventory.loading)}
				</p>
			)}
			{inventory.data ? (
				<AiModelDiagnostics
					accounts={accounts}
					views={inventory.data.accounts}
				/>
			) : null}
			<AiModelReference providers={providers} />
		</section>
	);
}
