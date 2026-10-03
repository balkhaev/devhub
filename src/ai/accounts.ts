import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";
import { z } from "zod";

import { AiStore } from "./store";
import {
	type AiAccountView,
	type AiCredential,
	AiError,
	type AiOAuthStart,
	type AiOAuthStatus,
	type AiProvider,
	safeAiError,
} from "./types";

// Protocol configuration studied in OmniRoute; attribution is in THIRD_PARTY_NOTICES.md.
const CLAUDE_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const OPENAI_RESOURCE = "https://api.openai.com/v1";
const OPENAI_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
const CLAUDE_TOKEN = "https://api.anthropic.com/v1/oauth/token";
const SCOPE_SEPARATOR = /\s+/;
const TOKEN_ENDPOINTS = {
	claude: CLAUDE_TOKEN,
	codex: "https://auth.openai.com/oauth/token",
	siwc: OPENAI_TOKEN,
};
const TTL = 10 * 60_000;
const REFRESH_MARGIN = 60_000;
const tokenSchema = z.object({
	access_token: z.string().min(1),
	account: z
		.object({
			email_address: z.string().optional(),
			uuid: z.string().optional(),
		})
		.optional(),
	expires_in: z.number().positive().finite().optional(),
	id_token: z.string().optional(),
	refresh_token: z.string().min(1).optional(),
	scope: z.string().optional(),
});
type Tokens = z.infer<typeof tokenSchema>;

interface Pending {
	account?: AiCredential;
	clientId: string;
	consumed: boolean;
	expiresAt: number;
	id: string;
	nonce: string;
	provider: AiProvider;
	redirectUri: string;
	result: AiOAuthStatus;
	state: string;
	verifier: string;
}

interface AccountsRuntime {
	fetch?: typeof globalThis.fetch;
	home?: string;
	now?: () => number;
	verifyIdToken?: (
		token: string,
		clientId: string,
		nonce: string
	) => Promise<Record<string, unknown>>;
}

function tokenFailureStatus(status: number): number {
	if (status === 429) {
		return 429;
	}
	return status >= 500 ? 502 : 401;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function equal(left: string, right: string): boolean {
	return (
		left.length === right.length &&
		timingSafeEqual(Buffer.from(left), Buffer.from(right))
	);
}

function publicAccount(account: AiCredential, now: number): AiAccountView {
	return {
		email: account.email,
		enabled: account.enabled !== false,
		expiresAt: account.expiresAt,
		id: account.id,
		label: account.label,
		maxConcurrency: account.maxConcurrency ?? 2,
		pool: {
			active: 0,
			completed: 0,
			failed: 0,
			inputTokens: 0,
			outputTokens: 0,
			requests: 0,
			status: account.enabled === false ? "disabled" : "ready",
		},
		priority: account.priority ?? 0,
		provider: account.provider,
		source: account.source,
		status:
			account.expiresAt &&
			account.expiresAt <= now &&
			!(account.source === "oauth" && account.refreshToken)
				? "expired"
				: "connected",
		weight: account.weight ?? 1,
	};
}

function identityId(...parts: string[]): string {
	return createHash("sha256")
		.update(parts.join("\0"))
		.digest("hex")
		.slice(0, 24);
}

/** Decoded CLI claims are display metadata only; new OAuth identities are signature verified. */
function cliClaims(token?: string): Record<string, unknown> {
	try {
		return token ? decodeJwt(token) : {};
	} catch {
		return {};
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class AiAccounts {
	readonly store: AiStore;
	private readonly fetcher: typeof globalThis.fetch;
	private readonly home: string;
	private readonly now: () => number;
	private readonly verify: NonNullable<AccountsRuntime["verifyIdToken"]>;
	private readonly pending = new Map<string, Pending>();
	private readonly disconnected = new Set<string>();
	private readonly refreshes = new Map<string, Promise<AiCredential>>();

	constructor(root: string, runtime: AccountsRuntime = {}) {
		this.store = new AiStore(root);
		this.fetcher = runtime.fetch ?? globalThis.fetch;
		this.home = runtime.home ?? homedir();
		this.now = runtime.now ?? Date.now;
		const jwks = createRemoteJWKSet(
			new URL("https://auth.openai.com/.well-known/jwks.json"),
			{ [customFetch]: this.fetcher, timeoutDuration: 15_000 }
		);
		this.verify =
			runtime.verifyIdToken ??
			(async (token, clientId, nonce) => {
				const { payload } = await jwtVerify(token, jwks, {
					algorithms: ["RS256"],
					audience: clientId,
					clockTolerance: 5,
					currentDate: new Date(this.now()),
					issuer: "https://auth.openai.com",
					requiredClaims: ["sub", "exp", "iat"],
				});
				if (payload.nonce !== nonce) {
					throw new AiError(
						"Вход OpenAI не прошёл проверку nonce. Начните заново.",
						401
					);
				}
				return payload;
			});
	}

	async list(): Promise<AiAccountView[]> {
		return (await this.store.list()).map((entry) =>
			publicAccount(entry, this.now())
		);
	}

	private sweep(): void {
		for (const [id, entry] of this.pending) {
			if (entry.expiresAt + TTL < this.now()) {
				this.pending.delete(id);
			}
		}
	}

	private async existingOAuth(
		provider: AiProvider,
		subject?: string
	): Promise<AiCredential | undefined> {
		if (!subject) {
			return undefined;
		}
		return (await this.store.list()).find(
			(saved) =>
				saved.provider === provider &&
				saved.source === "oauth" &&
				saved.subject === subject
		);
	}

	async startOAuth(
		provider: AiProvider,
		origin: string,
		accountId?: string
	): Promise<AiOAuthStart> {
		this.sweep();
		if (this.pending.size >= 20) {
			throw new AiError(
				"Слишком много попыток входа. Подождите или завершите текущую.",
				429
			);
		}
		const account = accountId ? await this.store.get(accountId) : undefined;
		if (
			account &&
			(account.provider !== provider || account.authMode !== "siwc")
		) {
			throw new AiError(
				"Повторный вход доступен для выбранного подключения ChatGPT.",
				400
			);
		}
		const callback = new URL("/auth/callback", origin);
		if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1") {
			throw new AiError("OAuth требует локальный адрес 127.0.0.1.", 400);
		}
		const entry: Pending = {
			account,
			clientId:
				provider === "claude"
					? CLAUDE_CLIENT
					: (account?.clientId ?? "dynamic_agent_client"),
			consumed: false,
			expiresAt: this.now() + TTL,
			id: randomBytes(16).toString("hex"),
			nonce: randomBytes(32).toString("base64url"),
			provider,
			redirectUri: provider === "claude" ? CLAUDE_REDIRECT : callback.href,
			result: { status: "pending" },
			state: randomBytes(32).toString("base64url"),
			verifier: randomBytes(32).toString("base64url"),
		};
		const challenge = createHash("sha256")
			.update(entry.verifier)
			.digest("base64url");
		const url = new URL(
			provider === "claude"
				? "https://claude.ai/oauth/authorize"
				: "https://auth.openai.com/api/accounts/authorize"
		);
		url.search = new URLSearchParams({
			client_id: entry.clientId,
			code_challenge: challenge,
			code_challenge_method: "S256",
			redirect_uri: entry.redirectUri,
			response_type: "code",
			scope:
				provider === "claude"
					? "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers"
					: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
			state: entry.state,
		}).toString();
		if (provider === "claude") {
			url.searchParams.set("code", "true");
			url.searchParams.set("prompt", "login");
		} else {
			url.searchParams.set("nonce", entry.nonce);
			url.searchParams.set("resource", OPENAI_RESOURCE);
			url.searchParams.set("ext_agent_host_id", await this.store.hostId());
			if (!account) {
				url.searchParams.set("agent_name_hint", "DevHub");
			}
			// Retained ID tokens stay on the server; login_hint suffices for the visible account selector.
			if (account?.email) {
				url.searchParams.set("login_hint", account.email);
			}
		}
		this.pending.set(entry.id, entry);
		return {
			expiresAt: entry.expiresAt,
			id: entry.id,
			manual: provider === "claude",
			url: url.href,
		};
	}

	oauthStatus(id: string): AiOAuthStatus {
		const entry = this.pending.get(id);
		if (!entry) {
			throw new AiError("Попытка входа не найдена. Начните заново.", 404);
		}
		if (entry.result.status === "pending" && entry.expiresAt <= this.now()) {
			return { status: "expired" };
		}
		return { ...entry.result };
	}

	async callback(url: URL): Promise<void> {
		const state = url.searchParams.get("state") ?? "";
		const entry = [...this.pending.values()].find(
			(attempt) => attempt.provider === "codex" && equal(attempt.state, state)
		);
		if (!entry || entry.expiresAt <= this.now() || entry.consumed) {
			throw new AiError(
				"Вход не прошёл проверку state, уже завершён или истёк. Начните заново.",
				400
			);
		}
		if (url.searchParams.has("error")) {
			entry.consumed = true;
			entry.result = {
				error: "Вход OpenAI отменён или не разрешён. Начните заново.",
				status: "error",
			};
			throw new AiError(entry.result.error ?? "Вход отменён.", 401);
		}
		await this.completeOAuth(
			entry.id,
			url.searchParams.get("code") ?? "",
			state,
			url.searchParams.get("client_id") ?? undefined
		);
	}

	private async tokens(
		url: string,
		body: BodyInit,
		json = false,
		refresh = false
	): Promise<Tokens> {
		const response = await this.fetcher(url, {
			body,
			headers: {
				Accept: "application/json",
				"Content-Type": json
					? "application/json"
					: "application/x-www-form-urlencoded",
				...(url === CLAUDE_TOKEN
					? { "anthropic-beta": "oauth-2025-04-20" }
					: {}),
			},
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new AiError(
				refresh
					? "Не удалось обновить подписку. Подключите аккаунт заново."
					: "Провайдер не завершил вход. Проверьте код и разрешения, затем начните заново.",
				tokenFailureStatus(response.status)
			);
		}
		const parsed = tokenSchema.safeParse(await response.json());
		if (!parsed.success) {
			throw new AiError(
				"Провайдер вернул неполные данные входа. Начните заново.",
				502
			);
		}
		return parsed.data;
	}

	private prepareOAuth(
		id: string,
		submittedCode: string,
		returnedState?: string,
		clientId?: string
	): { entry: Pending; code: string; state: string } {
		const entry = this.pending.get(id);
		if (!entry || entry.consumed || entry.expiresAt <= this.now()) {
			throw new AiError(
				"Попытка входа уже завершена или истекла. Начните заново.",
				400
			);
		}
		if (!submittedCode || submittedCode.length > 8192) {
			throw new AiError("Нужен код, показанный провайдером после входа.", 400);
		}
		const [code = "", codeState] = submittedCode.trim().split("#");
		const state = returnedState ?? codeState ?? entry.state;
		if (!equal(state, entry.state)) {
			throw new AiError(
				"Код относится к другой попытке входа. Начните заново.",
				400
			);
		}
		if (entry.provider === "codex") {
			if (entry.account && clientId && clientId !== entry.clientId) {
				throw new AiError(
					"OpenAI вернул другой client_id. Начните заново.",
					401
				);
			}
			const issued = entry.account?.clientId ?? clientId;
			if (
				!issued ||
				issued === "dynamic_agent_client" ||
				!issued.startsWith("oaiapp_")
			) {
				throw new AiError(
					"OpenAI не вернул client_id регистрации DevHub. Начните заново.",
					401
				);
			}
			entry.clientId = issued;
		}
		return { code, entry, state };
	}

	async completeOAuth(
		id: string,
		submittedCode: string,
		returnedState?: string,
		clientId?: string
	): Promise<void> {
		const { entry, code, state } = this.prepareOAuth(
			id,
			submittedCode,
			returnedState,
			clientId
		);
		entry.consumed = true;
		try {
			const payload = {
				client_id: entry.clientId,
				code,
				code_verifier: entry.verifier,
				grant_type: "authorization_code",
				redirect_uri: entry.redirectUri,
			};
			const tokens =
				entry.provider === "claude"
					? await this.tokens(
							CLAUDE_TOKEN,
							JSON.stringify({ ...payload, state }),
							true
						)
					: await this.tokens(
							OPENAI_TOKEN,
							new URLSearchParams({ ...payload, resource: OPENAI_RESOURCE })
						);
			let identity: Record<string, unknown> = {};
			const scopes = tokens.scope?.split(SCOPE_SEPARATOR).filter(Boolean) ?? [];
			if (entry.provider === "codex") {
				if (
					!(tokens.id_token && scopes.includes("chatgpt.tokens.use.direct"))
				) {
					throw new AiError(
						"OpenAI не разрешил использование подписки для DevHub. Подключите её с разрешением ChatGPT plan usage.",
						403
					);
				}
				identity = await this.verify(
					tokens.id_token,
					entry.clientId,
					entry.nonce
				);
				if (
					!stringValue(identity.sub) ||
					(entry.account?.subject && identity.sub !== entry.account.subject)
				) {
					throw new AiError(
						"Вход выполнен в другой аккаунт. Добавьте его отдельно.",
						401
					);
				}
			}
			const subject = stringValue(identity.sub) ?? tokens.account?.uuid;
			const email =
				stringValue(identity.email) ?? tokens.account?.email_address;
			// A fresh SIWC registration is not another person's subscription.
			const existing = await this.existingOAuth(entry.provider, subject);
			const account: AiCredential = {
				accessToken: tokens.access_token,
				authMode: entry.provider === "codex" ? "siwc" : "claude",
				clientId: entry.clientId,
				email,
				expiresAt: tokens.expires_in
					? this.now() + tokens.expires_in * 1000
					: undefined,
				id:
					entry.account?.id ??
					existing?.id ??
					identityId(
						entry.provider,
						subject ?? randomBytes(16).toString("hex")
					),
				idToken: tokens.id_token,
				label:
					email ??
					(entry.provider === "codex" ? "ChatGPT · DevHub" : "Claude · DevHub"),
				provider: entry.provider,
				refreshToken: tokens.refresh_token,
				scopes,
				source: "oauth",
				subject,
			};
			if (this.pending.get(entry.id) !== entry) {
				throw new AiError("Попытка входа остановлена. Начните заново.", 400);
			}
			await this.store.put(account);
			this.disconnected.delete(account.id);
			entry.result = { status: "complete" };
		} catch (error) {
			const safe = safeAiError(error);
			entry.result = { error: safe.error, status: "error" };
			throw new AiError(safe.error, { cause: error, status: safe.status });
		}
	}

	/** Native CLIs retain ownership of rotating refresh tokens; only access snapshots are imported. */
	async import(provider: AiProvider): Promise<void> {
		try {
			if (provider === "codex") {
				await this.importCodex();
			} else {
				await this.importClaude();
			}
		} catch (error) {
			if (error instanceof AiError) {
				throw error;
			}
			throw new AiError(
				provider === "codex"
					? "Не найдена подписка Codex в ~/.codex/auth.json. Выполните codex login и повторите импорт."
					: "Не найдена подписка Claude в ~/.claude/.credentials.json. Войдите в Claude Code и повторите импорт.",
				{ cause: error, status: 400 }
			);
		}
	}

	private async importCodex(): Promise<void> {
		const schema = z.object({
			tokens: z.object({
				access_token: z.string().min(1),
				account_id: z.string().optional(),
				id_token: z.string().optional(),
			}),
		});
		const data = schema.parse(
			JSON.parse(await readFile(join(this.home, ".codex", "auth.json"), "utf8"))
		);
		const identity = cliClaims(data.tokens.id_token);
		const access = cliClaims(data.tokens.access_token);
		const auth = z
			.object({
				chatgpt_account_id: z.string().optional(),
				chatgpt_user_id: z.string().optional(),
				user_id: z.string().optional(),
			})
			.safeParse(
				identity["https://api.openai.com/auth"] ??
					access["https://api.openai.com/auth"] ??
					{}
			);
		const accountId =
			data.tokens.account_id ??
			(auth.success ? auth.data.chatgpt_account_id : undefined);
		const subject =
			(auth.success
				? (auth.data.chatgpt_user_id ?? auth.data.user_id)
				: undefined) ??
			stringValue(identity.sub) ??
			stringValue(access.sub);
		if (!(accountId && subject)) {
			throw new AiError(
				"В Codex CLI не найден аккаунт подписки. Выполните codex login и повторите импорт.",
				401
			);
		}
		const email = stringValue(identity.email);
		const expires = numberValue(access.exp) ?? numberValue(identity.exp);
		await this.saveImported({
			accessToken: data.tokens.access_token,
			accountId,
			authMode: "codex",
			clientId: CODEX_CLIENT,
			email,
			expiresAt: expires ? expires * 1000 : undefined,
			id: identityId("codex-cli", accountId, subject),
			label: email ?? "Codex CLI",
			provider: "codex",
			source: "codex-cli",
			subject,
		});
	}

	private async importClaude(): Promise<void> {
		const schema = z.object({
			claudeAiOauth: z.object({
				accessToken: z.string().min(1),
				expiresAt: z.number().finite().optional(),
				scopes: z.array(z.string()).optional(),
			}),
		});
		const data = schema.parse(
			JSON.parse(
				await readFile(join(this.home, ".claude", ".credentials.json"), "utf8")
			)
		);
		await this.saveImported({
			accessToken: data.claudeAiOauth.accessToken,
			authMode: "claude",
			clientId: CLAUDE_CLIENT,
			expiresAt: data.claudeAiOauth.expiresAt,
			// Opaque Claude tokens contain no verified identity; retain distinct access snapshots.
			// Local CLI profile metadata can be stale after switching users and must not merge them.
			id: identityId("claude-cli", data.claudeAiOauth.accessToken),
			label: "Claude Code · импорт",
			provider: "claude",
			scopes: data.claudeAiOauth.scopes,
			source: "claude-cli",
		});
	}

	private async saveImported(account: AiCredential): Promise<void> {
		await this.store.put(account);
		this.disconnected.delete(account.id);
	}

	async credential(id: string, forceRefresh = false): Promise<AiCredential> {
		this.ensureConnected(id);
		const pending = this.refreshes.get(id);
		if (pending) {
			return pending;
		}
		const account = await this.store.get(id);
		this.ensureConnected(id);
		if (
			!forceRefresh &&
			(!account.expiresAt ||
				account.expiresAt >
					this.now() +
						(account.source === "oauth" && account.refreshToken
							? REFRESH_MARGIN
							: 0))
		) {
			return account;
		}
		if (!account.refreshToken || account.source !== "oauth") {
			throw new AiError(
				"Срок подключения истёк. Войдите заново или повторите импорт из CLI.",
				401
			);
		}
		// No await between checking and installing the lock; callers join the same refresh and persistence.
		const again = this.refreshes.get(id);
		if (again) {
			return again;
		}
		const refreshing = this.refresh(account).finally(() =>
			this.refreshes.delete(id)
		);
		this.refreshes.set(id, refreshing);
		return refreshing;
	}

	private async refresh(previous: AiCredential): Promise<AiCredential> {
		const account = await this.store.get(previous.id);
		const params = new URLSearchParams({
			client_id: account.clientId,
			grant_type: "refresh_token",
			refresh_token: account.refreshToken ?? "",
		});
		if (account.authMode === "siwc") {
			params.set("resource", OPENAI_RESOURCE);
		}
		try {
			const tokens = await this.tokens(
				TOKEN_ENDPOINTS[account.authMode],
				params,
				false,
				true
			);
			const scopes =
				tokens.scope?.split(SCOPE_SEPARATOR).filter(Boolean) ?? account.scopes;
			if (
				account.authMode === "siwc" &&
				!scopes?.includes("chatgpt.tokens.use.direct")
			) {
				throw new AiError(
					"Разрешение на использование подписки OpenAI отозвано. Войдите заново.",
					403
				);
			}
			const current = {
				...account,
				accessToken: tokens.access_token,
				expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000,
				idToken: tokens.id_token ?? account.idToken,
				refreshToken: stringValue(tokens.refresh_token) ?? account.refreshToken,
				scopes,
			};
			this.ensureConnected(account.id);
			return (await this.store.replaceCredential(account, current)).credential;
		} catch (error) {
			// Revoked tokens stop future refresh attempts; network/rate-limit failures remain retryable.
			if (
				error instanceof AiError &&
				(error.status === 401 || error.status === 403) &&
				!this.disconnected.has(account.id)
			) {
				const saved = await this.store.replaceCredential(account, {
					...account,
					expiresAt: this.now() - 1,
					refreshToken: undefined,
				});
				if (!saved.updated) {
					return saved.credential;
				}
			}
			const safe = safeAiError(error);
			throw new AiError(safe.error, { cause: error, status: safe.status });
		}
	}

	private ensureConnected(id: string): void {
		if (this.disconnected.has(id)) {
			throw new AiError("Подключение отключено. Войдите заново.", 401);
		}
	}

	async disconnect(id: string): Promise<void> {
		this.disconnected.add(id);
		const previous = await this.store.get(id);
		await this.refreshes.get(id)?.catch(() => undefined);
		if (this.disconnected.has(id)) {
			await this.store.removeCredential(previous);
		}
	}

	stop(): void {
		this.pending.clear();
	}
}
