import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { AiAccountView, AiProviderView } from "../ai/types";
import {
	type AiMessage,
	type AiModelList,
	type AiUsage,
	aiChat,
	aiRequest,
} from "./ai-api";

interface ChatMessage extends AiMessage {
	id: string;
}

function AiTokenLimit({
	disabled,
	onChange,
	supported,
	value,
}: {
	disabled: boolean;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
	supported: boolean;
	value: number;
}) {
	return (
		<>
			<label className="ai-field ai-token-limit">
				<span>Максимум токенов ответа</span>
				<input
					disabled={disabled || !supported}
					max={32_768}
					min={1}
					onChange={onChange}
					type="number"
					value={value}
				/>
			</label>
			{supported ? null : (
				<p className="muted small">
					Подключение из Codex CLI не поддерживает лимит токенов ответа.
					Генерацию можно остановить вручную.
				</p>
			)}
		</>
	);
}

export function AiConversation({
	messages,
	pending,
}: {
	messages: ChatMessage[];
	pending: boolean;
}) {
	if (!messages.length) {
		return (
			<div className="ai-chat__empty">
				<strong>Проверьте модель коротким запросом</strong>
				<p className="muted">Ответ будет появляться по мере генерации.</p>
			</div>
		);
	}
	return (
		<div className="ai-messages">
			{messages.map((message) => (
				<article
					className={`ai-message ai-message--${message.role}`}
					key={message.id}
				>
					<strong className="ai-message__role">
						{message.role === "user" ? "Вы" : "Модель"}
					</strong>
					<div className="ai-message__text">
						{message.content ||
							(pending ? "Модель готовит ответ…" : "Ответ не получен.")}
					</div>
				</article>
			))}
		</div>
	);
}

function useModels(
	account: AiAccountView | undefined,
	providers: AiProviderView[]
) {
	const [models, setModels] = useState<AiModelList | null>(null);
	const [model, setModel] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const accountId = account?.id;
	const provider = providers.find((entry) => entry.id === account?.provider);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit user-requested refresh trigger.
	useEffect(() => {
		setModels(null);
		setModel("");
		setError(null);
		if (!accountId) {
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		aiRequest<AiModelList>(
			`accounts/${encodeURIComponent(accountId)}/models`,
			undefined,
			controller.signal
		)
			.then((result) => {
				if (!controller.signal.aborted) {
					setModels(result);
					setModel(result.models[0]?.id ?? "");
					setError(result.error ?? null);
				}
			})
			.catch((failure: Error) => {
				if (!controller.signal.aborted) {
					const fallback = provider?.models ?? [];
					setModels({ models: fallback, source: "catalog" });
					setModel(fallback[0]?.id ?? "");
					setError(failure.message);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [accountId, provider, revision]);
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	return { error, loading, model, models, refresh, setModel };
}

export function AiPlayground({
	accounts,
	providers,
}: {
	accounts: AiAccountView[];
	providers: AiProviderView[];
}) {
	const available = accounts.filter((entry) => entry.status === "connected");
	const [selected, setSelected] = useState("");
	const account =
		available.find((entry) => entry.id === selected) ?? available[0];
	const selectAccount = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			setSelected(event.currentTarget.value),
		[]
	);
	if (!account) {
		return (
			<section aria-label="Запрос к модели" className="ai-playground">
				<h2>Запрос к модели</h2>
				<p className="ai-chat__empty muted">
					Подключите подписку выше, чтобы выбрать модель и отправить запрос.
				</p>
			</section>
		);
	}
	return (
		<AiSession
			account={account}
			available={available}
			key={account.id}
			onAccountChange={selectAccount}
			providers={providers}
		/>
	);
}

function AiSession({
	account,
	available,
	onAccountChange,
	providers,
}: {
	account: AiAccountView;
	available: AiAccountView[];
	onAccountChange: (event: ChangeEvent<HTMLSelectElement>) => void;
	providers: AiProviderView[];
}) {
	const accountId = account.id;
	const supportsTokenLimit = account.source !== "codex-cli";
	const {
		error: modelError,
		loading,
		model,
		models,
		refresh,
		setModel,
	} = useModels(account, providers);
	const [customModel, setCustomModel] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [prompt, setPrompt] = useState("");
	const [system, setSystem] = useState("");
	const [maxTokens, setMaxTokens] = useState(4096);
	const requestedTokenLimit = supportsTokenLimit ? maxTokens : undefined;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [usage, setUsage] = useState<AiUsage | null>(null);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const newChat = useCallback(() => {
		setMessages([]);
		setError(null);
		setNotice(null);
		setUsage(null);
	}, []);
	const send = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const content = prompt.trim();
			const modelId = model === "custom" ? customModel.trim() : model;
			if (!(accountId && modelId && content) || pending) {
				return;
			}
			const next = [
				...messages,
				{ content, id: crypto.randomUUID(), role: "user" as const },
			];
			const replyId = crypto.randomUUID();
			setMessages([...next, { content: "", id: replyId, role: "assistant" }]);
			setPrompt("");
			setError(null);
			setNotice(null);
			setUsage(null);
			setPending(true);
			const request = new AbortController();
			controller.current = request;
			const context: AiMessage[] = next
				.filter((message) => message.content)
				.map(({ content: text, role }) => ({ content: text, role }));
			if (system.trim()) {
				context.unshift({ content: system.trim(), role: "system" });
			}
			let receivedText = false;
			try {
				await aiChat(
					{
						accountId,
						maxTokens: requestedTokenLimit,
						messages: context,
						model: modelId,
					},
					(chunk) => {
						if (chunk.type === "text") {
							receivedText ||= Boolean(chunk.text);
							setMessages((current) =>
								current.map((message) =>
									message.id === replyId
										? { ...message, content: message.content + chunk.text }
										: message
								)
							);
						} else if (chunk.type === "done") {
							setUsage(chunk.usage ?? null);
						}
					},
					request.signal
				);
			} catch (failure) {
				if (request.signal.aborted) {
					setNotice(
						"Запрос остановлен. Полученная часть ответа сохранена на экране."
					);
				} else {
					setError((failure as Error).message);
					if (!receivedText) {
						setMessages(messages);
						setPrompt(content);
					}
				}
			} finally {
				controller.current = null;
				setPending(false);
			}
		},
		[
			accountId,
			customModel,
			requestedTokenLimit,
			messages,
			model,
			pending,
			prompt,
			system,
		]
	);
	const stop = useCallback(() => controller.current?.abort(), []);
	const editModel = useCallback(
		(event: ChangeEvent<HTMLSelectElement>) =>
			setModel(event.currentTarget.value),
		[setModel]
	);
	const editCustomModel = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setCustomModel(event.currentTarget.value),
		[]
	);
	const editSystem = useCallback(
		(event: ChangeEvent<HTMLTextAreaElement>) =>
			setSystem(event.currentTarget.value),
		[]
	);
	const editMaxTokens = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setMaxTokens(Number(event.currentTarget.value)),
		[]
	);
	const editPrompt = useCallback(
		(event: ChangeEvent<HTMLTextAreaElement>) =>
			setPrompt(event.currentTarget.value),
		[]
	);
	const effectiveModel = model === "custom" ? customModel.trim() : model;
	const statusText = pending ? "Получаю ответ…" : notice;
	return (
		<section aria-label="Запрос к модели" className="ai-playground">
			<div className="ai-section-head">
				<div>
					<h2>Запрос к модели</h2>
					<p className="muted">
						Диалог хранится только на этой странице. Запросы используют лимиты
						подписки.
					</p>
				</div>
				<button
					className="button"
					disabled={pending || !messages.length}
					onClick={newChat}
					type="button"
				>
					Новый диалог
				</button>
			</div>
			<div className="ai-chat-controls">
				<label className="ai-field">
					<span>Подписка</span>
					<select
						disabled={pending}
						onChange={onAccountChange}
						value={accountId}
					>
						{available.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.provider === "codex" ? "Codex" : "Claude"} ·{" "}
								{entry.label}
							</option>
						))}
					</select>
				</label>
				<label className="ai-field">
					<span>Модель</span>
					<select
						disabled={pending || loading}
						onChange={editModel}
						value={model}
					>
						{loading ? <option value="">Загружаю модели…</option> : null}
						{models?.models.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.name}
							</option>
						))}
						<option value="custom">Другой идентификатор…</option>
					</select>
				</label>
				<button
					className="button"
					disabled={pending || loading}
					onClick={refresh}
					type="button"
				>
					Обновить модели
				</button>
			</div>
			{model === "custom" ? (
				<label className="ai-field ai-custom-model">
					<span>Идентификатор модели</span>
					<input
						disabled={pending}
						onChange={editCustomModel}
						placeholder="Введите идентификатор доступной вам модели"
						value={customModel}
					/>
				</label>
			) : null}
			{models ? (
				<p className="muted small">
					{models.source === "remote"
						? "Модели получены из подключённой подписки."
						: "Показан встроенный каталог; доступность зависит от подписки."}
				</p>
			) : null}
			{modelError ? (
				<p className="ai-error" role="alert">
					{modelError}
				</p>
			) : null}
			<details className="ai-settings">
				<summary>Настройки запроса</summary>
				<label className="ai-field">
					<span>Системная инструкция</span>
					<textarea
						disabled={pending}
						onChange={editSystem}
						placeholder="Необязательная инструкция для модели"
						rows={3}
						value={system}
					/>
				</label>
				<AiTokenLimit
					disabled={pending}
					onChange={editMaxTokens}
					supported={supportsTokenLimit}
					value={maxTokens}
				/>
			</details>
			<div className="ai-chat">
				<AiConversation messages={messages} pending={pending} />
			</div>
			<div className="ai-chat-status" role="status">
				{statusText}
				{usage
					? `Токены: ${usage.inputTokens} на входе · ${usage.outputTokens} в ответе`
					: null}
			</div>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
			<form className="ai-prompt" onSubmit={send}>
				<label className="ai-field">
					<span>Сообщение</span>
					<textarea
						disabled={pending}
						onChange={editPrompt}
						placeholder="Напишите сообщение Claude или Codex…"
						required
						rows={3}
						value={prompt}
					/>
				</label>
				<div className="ai-actions">
					<button
						className="button button--primary"
						disabled={
							pending ||
							loading ||
							!effectiveModel ||
							!prompt.trim() ||
							(supportsTokenLimit && (maxTokens < 1 || maxTokens > 32_768))
						}
						type="submit"
					>
						{pending ? "Генерация…" : "Отправить"}
					</button>
					{pending ? (
						<button className="button" onClick={stop} type="button">
							Остановить
						</button>
					) : null}
				</div>
			</form>
		</section>
	);
}
