import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useState,
} from "react";

import type { AiAccountView, AiProviderView } from "../ai/types";
import { type AiOAuthFlow, type AiOAuthStatus, aiRequest } from "./ai-api";
import { AiPoolControls, AiPoolStatus } from "./ai-pool";

const SOURCE_NAMES: Record<AiAccountView["source"], string> = {
	"claude-cli": "Claude Code",
	"codex-cli": "Codex CLI",
	oauth: "Вход через браузер",
	token: "Локальный токен",
};

function expiryText(expiresAt: number): string {
	return new Date(expiresAt).toLocaleString("ru-RU", {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
	});
}

export function AiAccount({
	account,
	busy = false,
	onReconnect,
	onRefresh,
}: {
	account: AiAccountView;
	busy?: boolean;
	onReconnect?: (id: string) => Promise<void>;
	onRefresh: () => Promise<void>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const disconnect = useCallback(async () => {
		setPending(true);
		setError(null);
		try {
			await aiRequest(
				`accounts/${encodeURIComponent(account.id)}/disconnect`,
				{}
			);
			await onRefresh();
		} catch (failure) {
			setError((failure as Error).message);
		} finally {
			setPending(false);
		}
	}, [account.id, onRefresh]);
	const reconnect = useCallback(async () => {
		await onReconnect?.(account.id);
	}, [account.id, onReconnect]);
	return (
		<div className="ai-account">
			<div className="ai-account__head">
				<strong>{account.label}</strong>
				<span className={`ai-status ai-status--${account.status}`}>
					{account.status === "connected" ? "Подключён" : "Вход истёк"}
				</span>
			</div>
			{account.email ? <span className="muted">{account.email}</span> : null}
			<span className="muted small">
				{SOURCE_NAMES[account.source]}
				{account.expiresAt
					? ` · токен до ${expiryText(account.expiresAt)}`
					: ""}
			</span>
			<AiPoolStatus account={account} />
			<AiPoolControls account={account} onRefresh={onRefresh} />
			<div className="ai-actions">
				{account.provider === "codex" &&
				account.source === "oauth" &&
				onReconnect ? (
					<button
						className="button button--small"
						disabled={pending || busy}
						onClick={reconnect}
						type="button"
					>
						Войти заново
					</button>
				) : null}
				<button
					className="button button--small"
					disabled={pending || busy}
					onClick={disconnect}
					type="button"
				>
					{pending ? "Отключаю…" : "Отключить в DevHub"}
				</button>
			</div>
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}

function OAuthInstructions({
	flow,
	onComplete,
	pending,
}: {
	flow: AiOAuthFlow;
	onComplete: (code: string) => Promise<void>;
	pending: boolean;
}) {
	const [code, setCode] = useState("");
	const submit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const value = code.trim();
			if (!value) {
				return;
			}
			setCode("");
			await onComplete(value);
		},
		[code, onComplete]
	);
	const editCode = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setCode(event.currentTarget.value),
		[]
	);
	return (
		<div className="ai-oauth">
			<p>
				<a
					className="ai-link"
					href={flow.url}
					rel="noopener noreferrer"
					target="_blank"
				>
					Открыть страницу входа ↗
				</a>
			</p>
			<p className="muted small">
				{flow.manual
					? "После входа скопируйте выданный код и вставьте ниже."
					: "Завершите вход в браузере. Подключение появится здесь автоматически."}
				{` Ссылка действует до ${expiryText(flow.expiresAt)}.`}
			</p>
			{flow.manual ? (
				<form className="ai-code-form" onSubmit={submit}>
					<label className="ai-field">
						<span>Код подтверждения</span>
						<input
							autoComplete="off"
							disabled={pending}
							onChange={editCode}
							placeholder="Вставьте код со страницы Claude"
							required
							spellCheck={false}
							type="password"
							value={code}
						/>
					</label>
					<button
						className="button"
						disabled={pending || !code.trim()}
						type="submit"
					>
						{pending ? "Подключаю…" : "Подтвердить код"}
					</button>
				</form>
			) : null}
		</div>
	);
}

export function AiProviderCard({
	accounts,
	onRefresh,
	provider,
}: {
	accounts: AiAccountView[];
	onRefresh: () => Promise<void>;
	provider: AiProviderView;
}) {
	const [flow, setFlow] = useState<AiOAuthFlow | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	useEffect(() => {
		if (!flow) {
			return;
		}
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const result = await aiRequest<AiOAuthStatus>(
					`oauth/${encodeURIComponent(flow.id)}`,
					undefined,
					controller.signal
				);
				if (result.status === "complete") {
					setFlow(null);
					setNotice("Подписка подключена.");
					await onRefresh();
					return;
				}
				if (result.status === "error" || result.status === "expired") {
					setFlow(null);
					setError(
						result.error ?? "Ссылка для входа истекла. Начните вход заново."
					);
					return;
				}
				timer = setTimeout(poll, 1500);
			} catch (failure) {
				if (!controller.signal.aborted) {
					setError((failure as Error).message);
					timer = setTimeout(poll, 5000);
				}
			}
		};
		poll().catch(() => undefined);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [flow, onRefresh]);
	const startLogin = useCallback(
		async (accountId?: string) => {
			setPending("connect");
			setError(null);
			setNotice(null);
			try {
				const next = await aiRequest<AiOAuthFlow>("oauth/start", {
					provider: provider.id,
					...(accountId ? { accountId } : {}),
				});
				setFlow(next);
				window.open(next.url, "_blank", "noopener,noreferrer");
			} catch (failure) {
				setError((failure as Error).message);
			} finally {
				setPending(null);
			}
		},
		[provider.id]
	);
	const connect = useCallback(() => startLogin(), [startLogin]);
	const reconnect = useCallback((id: string) => startLogin(id), [startLogin]);
	const importCli = useCallback(async () => {
		setPending("import");
		setError(null);
		setNotice(null);
		try {
			await aiRequest("import", { provider: provider.id });
			await onRefresh();
			setNotice("Подключение из CLI добавлено.");
		} catch (failure) {
			setError((failure as Error).message);
		} finally {
			setPending(null);
		}
	}, [provider.id, onRefresh]);
	const complete = useCallback(
		async (code: string) => {
			if (!flow) {
				return;
			}
			setPending("complete");
			setError(null);
			try {
				await aiRequest(`oauth/${encodeURIComponent(flow.id)}/complete`, {
					code,
				});
				setFlow(null);
				await onRefresh();
				setNotice("Подписка подключена.");
			} catch (failure) {
				setError((failure as Error).message);
			} finally {
				setPending(null);
			}
		},
		[flow, onRefresh]
	);
	let connectLabel = accounts.length
		? "Добавить подписку"
		: "Подключить подписку";
	if (flow) {
		connectLabel = "Начать вход заново";
	}
	if (pending === "connect") {
		connectLabel = "Готовлю вход…";
	}
	return (
		<section aria-label={provider.name} className="ai-provider">
			<div className="ai-provider__head">
				<span
					aria-hidden="true"
					className={`ai-provider__mark ai-provider__mark--${provider.id}`}
				>
					{provider.id === "codex" ? "O" : "C"}
				</span>
				<div>
					<h2>{provider.name}</h2>
					<p className="muted">{provider.description}</p>
				</div>
			</div>
			<div className="ai-provider__accounts">
				{accounts.length ? (
					accounts.map((account) => (
						<AiAccount
							account={account}
							busy={Boolean(pending)}
							key={account.id}
							onReconnect={reconnect}
							onRefresh={onRefresh}
						/>
					))
				) : (
					<p className="muted">Подписка пока не подключена.</p>
				)}
			</div>
			<div className="ai-actions">
				<button
					className="button button--primary"
					disabled={Boolean(pending)}
					onClick={connect}
					type="button"
				>
					{connectLabel}
				</button>
				<button
					className="button"
					disabled={Boolean(pending)}
					onClick={importCli}
					type="button"
				>
					{pending === "import"
						? "Импортирую…"
						: `Импорт из ${provider.id === "codex" ? "Codex CLI" : "Claude Code"}`}
				</button>
			</div>
			<p className="muted small ai-import-hint">
				Для нескольких подписок входите в разные аккаунты. Повторный импорт
				обновляет уже добавленный аккаунт.
			</p>
			{flow ? (
				<OAuthInstructions
					flow={flow}
					key={flow.id}
					onComplete={complete}
					pending={pending === "complete"}
				/>
			) : null}
			{notice ? (
				<p className="ai-notice" role="status">
					{notice}
				</p>
			) : null}
			{error ? (
				<p className="ai-error" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
}
