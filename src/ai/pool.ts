import { createHash } from "node:crypto";

import type { AiLifecycleEvent } from "./inference";
import type { AiStore } from "./store";
import {
	type AiAccountPoolView,
	type AiAccountView,
	type AiCredential,
	AiError,
	type AiModelAlias,
	type AiProvider,
	type AiProxyKey,
	type AiRoutingStrategy,
	type AiUsageStats,
} from "./types";

const SESSION_TTL = 30 * 60_000;
const MAX_ACTIVE = 64;
const MAX_MODELS = 1024;
const MAX_SESSIONS = 2048;
const OPENAI_MODEL = /^(gpt-|o[1-9](?:-|$)|codex(?:-|$))/i;

export function emptyUsage(): AiUsageStats {
	return {
		completed: 0,
		failed: 0,
		inputTokens: 0,
		outputTokens: 0,
		requests: 0,
	};
}

interface RuntimeAccount {
	active: number;
	blocked: boolean;
	blockedTokens: Set<string>;
	cooldowns: Map<string, number>;
	fingerprint: string;
	lastError?: string;
	lastLatencyMs?: number;
	lastSelected: number;
	stats: AiUsageStats;
}

interface ParsedRoute {
	accountId?: string;
	model: string;
	provider?: AiProvider;
}

export interface AiRoute extends ParsedRoute {
	provider: AiProvider;
	publicModel: string;
}

export interface AiLease {
	accountId: string;
	finish: (event: AiLifecycleEvent) => void;
}

export class AiPoolError extends AiError {
	readonly retryAfterMs?: number;
	constructor(message: string, status: number, retryAfterMs?: number) {
		super(message, status);
		this.retryAfterMs = retryAfterMs;
	}
}

function modelName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 320) {
		throw new AiError("Нужно имя модели.", 400);
	}
	return value;
}

function parseRoute(
	model: string,
	alias: AiModelAlias | undefined,
	pinnedAccount?: string
): ParsedRoute {
	let raw = alias?.model ?? model;
	let provider = alias?.provider;
	let accountId = alias?.accountId;
	const slash = raw.indexOf("/");
	if (slash > 0) {
		const prefix = raw.slice(0, slash);
		if (prefix === "codex" || prefix === "claude") {
			provider = prefix;
		} else {
			accountId = prefix;
		}
		raw = raw.slice(slash + 1);
	}
	if (!raw || raw.includes("/")) {
		throw new AiError("Некорректное имя модели.", 400);
	}
	if (pinnedAccount && accountId && pinnedAccount !== accountId) {
		throw new AiError(
			"Аккаунт в маршруте и x-devhub-account различается.",
			400
		);
	}
	return { accountId: pinnedAccount ?? accountId, model: raw, provider };
}

export function inferProvider(model: string): AiProvider | undefined {
	if (model.startsWith("claude-")) {
		return "claude";
	}
	if (OPENAI_MODEL.test(model)) {
		return "codex";
	}
	return undefined;
}

function assertKeyRoute(route: AiRoute, key?: AiProxyKey): void {
	if (key?.allowedProviders && !key.allowedProviders.includes(route.provider)) {
		throw new AiError("Ключ не разрешает эту модель или провайдера.", 403);
	}
	if (
		key?.allowedModels &&
		!key.allowedModels.includes(route.publicModel) &&
		!key.allowedModels.includes(`${route.provider}/${route.model}`)
	) {
		throw new AiError("Ключ не разрешает эту модель или провайдера.", 403);
	}
}

function poolStatus(
	account: AiAccountView,
	runtime: RuntimeAccount | undefined,
	cooldownUntil?: number
): AiAccountPoolView["status"] {
	if (!account.enabled) {
		return "disabled";
	}
	if (runtime?.blocked || account.status === "expired") {
		return "unauthorized";
	}
	return cooldownUntil ? "cooldown" : "ready";
}

function cooldown(runtime: RuntimeAccount, model: string): number {
	return Math.max(
		runtime.cooldowns.get(model) ?? 0,
		runtime.cooldowns.get("*") ?? 0
	);
}

function inScope(
	account: AiCredential,
	route: AiRoute,
	key?: AiProxyKey
): boolean {
	return (
		account.provider === route.provider &&
		(!route.accountId || route.accountId === account.id) &&
		(!key?.allowedAccounts || key.allowedAccounts.includes(account.id))
	);
}

function expiredSnapshot(account: AiCredential, now: number): boolean {
	return Boolean(
		account.expiresAt && account.expiresAt <= now && !account.refreshToken
	);
}

function highestPriority(candidates: AiCredential[]): AiCredential[] {
	const priority = Math.max(
		...candidates.map((account) => account.priority ?? 0)
	);
	return candidates
		.filter((account) => (account.priority ?? 0) === priority)
		.sort((a, b) => a.id.localeCompare(b.id));
}

function boundedMap<Value>(map: Map<string, Value>, limit: number): void {
	if (map.size < limit) {
		return;
	}
	const first = map.keys().next().value;
	if (first !== undefined) {
		map.delete(first);
	}
}

function errorLabel(status?: number): string {
	if (status === 429) {
		return "Лимит провайдера";
	}
	if (status === 401 || status === 403) {
		return "Требуется повторный вход";
	}
	return "Ошибка запроса";
}

function quotaFailure(event: AiLifecycleEvent): boolean {
	return (
		event.status === 429 ||
		event.code === "subscription_sharing_usage_limit_exceeded" ||
		event.code === "subscription_sharing_usage_unavailable"
	);
}

/** One process-local scheduler. Reservation is synchronous after loading the vault snapshot. */
export class AiPool {
	private readonly store: AiStore;
	private readonly now: () => number;
	private readonly modelSupport?: (
		account: AiCredential,
		model: string
	) => boolean | undefined;
	private readonly accounts = new Map<string, RuntimeAccount>();
	private readonly weights = new Map<string, Map<string, number>>();
	private readonly sessions = new Map<
		string,
		{ accountId: string; expiresAt: number }
	>();
	private readonly totals = emptyUsage();
	private active = 0;

	constructor(
		store: AiStore,
		now = Date.now,
		modelSupport?: (account: AiCredential, model: string) => boolean | undefined
	) {
		this.store = store;
		this.now = now;
		this.modelSupport = modelSupport;
	}

	stats(): AiUsageStats {
		return { ...this.totals };
	}

	private runtime(account: AiCredential): RuntimeAccount {
		const fingerprint = createHash("sha256")
			.update(account.accessToken)
			.digest("hex");
		let value = this.accounts.get(account.id);
		if (!value) {
			value = {
				active: 0,
				blocked: false,
				blockedTokens: new Set(),
				cooldowns: new Map(),
				fingerprint,
				lastSelected: 0,
				stats: emptyUsage(),
			};
			this.accounts.set(account.id, value);
		} else if (value.fingerprint !== fingerprint) {
			value.fingerprint = fingerprint;
			value.blocked = value.blockedTokens.has(fingerprint);
			value.lastError = undefined;
		}
		for (const [model, until] of value.cooldowns) {
			if (until <= this.now()) {
				value.cooldowns.delete(model);
			}
		}
		return value;
	}

	async views(accounts: AiAccountView[]): Promise<AiAccountView[]> {
		const credentials = await this.store.list();
		const current = new Map(credentials.map((entry) => [entry.id, entry]));
		for (const [id, runtime] of this.accounts) {
			if (!current.has(id) && runtime.active === 0) {
				this.accounts.delete(id);
			}
		}
		return accounts.map((account) =>
			this.accountView(account, current.get(account.id))
		);
	}

	private accountView(
		account: AiAccountView,
		credential?: AiCredential
	): AiAccountView {
		const runtime = credential
			? this.runtime(credential)
			: this.accounts.get(account.id);
		const cooldownUntil = runtime?.cooldowns.size
			? Math.max(...runtime.cooldowns.values())
			: undefined;
		const pool: AiAccountPoolView = {
			...(runtime?.stats ?? emptyUsage()),
			active: runtime?.active ?? 0,
			cooldownUntil,
			lastError: runtime?.lastError,
			lastLatencyMs: runtime?.lastLatencyMs,
			status: poolStatus(account, runtime, cooldownUntil),
		};
		return { ...account, pool };
	}

	async route(
		model: unknown,
		forcedProvider?: AiProvider,
		pinnedAccount?: string,
		key?: AiProxyKey
	): Promise<AiRoute> {
		const publicModel = modelName(model);
		const { aliases } = await this.store.proxyConfig();
		const parsed = parseRoute(
			publicModel,
			aliases.find((entry) => entry.id === publicModel),
			pinnedAccount
		);
		const provider = await this.resolveProvider(parsed, forcedProvider);
		const route = { ...parsed, provider, publicModel };
		assertKeyRoute(route, key);
		return route;
	}

	private async resolveProvider(
		route: ParsedRoute,
		forcedProvider?: AiProvider
	): Promise<AiProvider> {
		let { provider } = route;
		if (route.accountId) {
			const account = await this.store.get(route.accountId);
			if (provider && account.provider !== provider) {
				throw new AiError("Аккаунт не соответствует провайдеру маршрута.", 400);
			}
			({ provider } = account);
		}
		if (forcedProvider && provider && forcedProvider !== provider) {
			throw new AiError("Формат API не соответствует провайдеру модели.", 400);
		}
		provider ??= forcedProvider ?? inferProvider(route.model);
		if (!provider) {
			const providers = new Set(
				(await this.store.list())
					.filter((entry) => entry.enabled !== false)
					.map((entry) => entry.provider)
			);
			if (providers.size === 1) {
				[provider] = providers;
			}
		}
		if (!provider) {
			throw new AiError(
				"Укажите провайдера: codex/model, claude/model или имя маршрута.",
				400
			);
		}
		return provider;
	}

	private sessionId(
		route: AiRoute,
		session?: string,
		key?: AiProxyKey
	): string | undefined {
		if (!session) {
			return undefined;
		}
		if (session.length > 200) {
			throw new AiError("Слишком длинный x-devhub-session.", 400);
		}
		return createHash("sha256")
			.update(
				`${key?.id ?? "admin"}\0${route.provider}\0${route.model}\0${session}`
			)
			.digest("hex");
	}

	async acquire(
		route: AiRoute,
		excluded: Set<string>,
		session?: string,
		key?: AiProxyKey
	): Promise<AiLease> {
		const credentials = await this.store.list();
		const { strategy } = await this.store.proxyConfig();
		// Eligibility, selection, affinity and reservation below have no await: concurrent callers cannot overbook capacity.
		const scope = credentials.filter((account) => inScope(account, route, key));
		if (!scope.length) {
			throw new AiError(
				key?.allowedAccounts
					? "Нет разрешённых подключений для этого ключа."
					: "Нет подключённых подписок провайдера.",
				key?.allowedAccounts ? 403 : 400
			);
		}
		const now = this.now();
		const supported = scope.filter(
			(account) => this.modelSupport?.(account, route.model) !== false
		);
		if (!supported.length) {
			throw new AiError(
				"Модель отсутствует в доступных моделях выбранных подписок.",
				404
			);
		}
		const candidates = supported.filter((account) =>
			this.eligible(account, route.model, excluded, now)
		);
		this.checkCapacity(candidates, supported, route.model, now);
		const tier = highestPriority(candidates);
		const sessionId = this.sessionId(route, session, key);
		const selected = this.select(tier, strategy, route, sessionId, now);
		if (!selected) {
			throw new AiError("Не удалось выбрать подписку.", 429);
		}
		this.rememberSession(sessionId, selected.id, now);
		return this.reserve(selected, now);
	}

	private eligible(
		account: AiCredential,
		model: string,
		excluded: Set<string>,
		now: number
	): boolean {
		const runtime = this.runtime(account);
		return (
			account.enabled !== false &&
			!excluded.has(account.id) &&
			!runtime.blocked &&
			!expiredSnapshot(account, now) &&
			cooldown(runtime, model) <= now &&
			runtime.active < (account.maxConcurrency ?? 2)
		);
	}

	private checkCapacity(
		candidates: AiCredential[],
		scope: AiCredential[],
		model: string,
		now: number
	): void {
		if (this.active < MAX_ACTIVE && candidates.length) {
			return;
		}
		const reset = scope
			.map((account) => cooldown(this.runtime(account), model))
			.filter((until) => until > now);
		throw new AiPoolError(
			"Все подходящие подписки заняты, отключены или временно недоступны.",
			429,
			reset.length ? Math.min(...reset) - now : 1000
		);
	}

	private select(
		tier: AiCredential[],
		strategy: AiRoutingStrategy,
		route: AiRoute,
		sessionId: string | undefined,
		now: number
	): AiCredential | undefined {
		const sticky = sessionId ? this.sessions.get(sessionId) : undefined;
		if (sticky && sticky.expiresAt > now) {
			const selected = tier.find((account) => account.id === sticky.accountId);
			if (selected) {
				return selected;
			}
		}
		if (strategy === "least-busy") {
			return this.leastBusy(tier);
		}
		if (strategy === "round-robin") {
			return this.roundRobin(tier, `${route.provider}/${route.model}`);
		}
		const [first] = tier;
		return first;
	}

	private leastBusy(tier: AiCredential[]): AiCredential | undefined {
		const [selected] = [...tier].sort((a, b) => {
			const left = this.runtime(a);
			const right = this.runtime(b);
			return (
				left.active / ((a.maxConcurrency ?? 2) * (a.weight ?? 1)) -
					right.active / ((b.maxConcurrency ?? 2) * (b.weight ?? 1)) ||
				left.lastSelected - right.lastSelected
			);
		});
		return selected;
	}

	private roundRobin(
		tier: AiCredential[],
		model: string
	): AiCredential | undefined {
		let weights = this.weights.get(model);
		if (!weights) {
			weights = new Map();
			boundedMap(this.weights, MAX_MODELS);
			this.weights.set(model, weights);
		}
		for (const account of tier) {
			weights.set(
				account.id,
				(weights.get(account.id) ?? 0) + (account.weight ?? 1)
			);
		}
		const [selected] = [...tier].sort(
			(a, b) => (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0)
		);
		if (selected) {
			weights.set(
				selected.id,
				(weights.get(selected.id) ?? 0) -
					tier.reduce((sum, account) => sum + (account.weight ?? 1), 0)
			);
		}
		return selected;
	}

	private rememberSession(
		sessionId: string | undefined,
		accountId: string,
		now: number
	): void {
		if (!sessionId) {
			return;
		}
		boundedMap(this.sessions, MAX_SESSIONS);
		this.sessions.set(sessionId, { accountId, expiresAt: now + SESSION_TTL });
	}

	private reserve(account: AiCredential, startedAt: number): AiLease {
		const runtime = this.runtime(account);
		const credentialFingerprint = runtime.fingerprint;
		runtime.active += 1;
		runtime.lastSelected = startedAt;
		runtime.stats.requests += 1;
		this.totals.requests += 1;
		this.active += 1;
		let finished = false;
		return {
			accountId: account.id,
			finish: (event) => {
				if (finished) {
					return;
				}
				finished = true;
				this.finish(runtime, event, startedAt, credentialFingerprint);
			},
		};
	}

	private finish(
		runtime: RuntimeAccount,
		event: AiLifecycleEvent,
		startedAt: number,
		credentialFingerprint: string
	): void {
		runtime.active -= 1;
		this.active -= 1;
		runtime.lastLatencyMs = Math.max(0, this.now() - startedAt);
		if (event.kind === "complete") {
			runtime.stats.completed += 1;
			this.totals.completed += 1;
			runtime.lastError = undefined;
		} else {
			runtime.stats.failed += 1;
			this.totals.failed += 1;
			if (event.kind !== "cancel") {
				runtime.lastError = errorLabel(event.status);
			}
		}
		this.recordAvailability(runtime, event, credentialFingerprint);
		if (event.usage) {
			for (const stats of [runtime.stats, this.totals]) {
				stats.inputTokens += Math.max(0, event.usage.inputTokens);
				stats.outputTokens += Math.max(0, event.usage.outputTokens);
			}
		}
	}

	private recordAvailability(
		runtime: RuntimeAccount,
		event: AiLifecycleEvent,
		credentialFingerprint: string
	): void {
		if (quotaFailure(event)) {
			boundedMap(runtime.cooldowns, MAX_MODELS);
			// Unknown quota failures may apply across models; token refresh never replenishes quota.
			runtime.cooldowns.set(
				"*",
				this.now() +
					Math.min(
						Math.max(event.retryAfterMs ?? 60_000, 1000),
						24 * 60 * 60_000
					)
			);
		}
		if (event.status === 401) {
			if (runtime.blockedTokens.size >= 32) {
				runtime.blockedTokens.delete(
					runtime.blockedTokens.values().next().value ?? ""
				);
			}
			runtime.blockedTokens.add(
				event.credentialFingerprint ?? credentialFingerprint
			);
			runtime.blocked = runtime.blockedTokens.has(runtime.fingerprint);
		}
	}
}
