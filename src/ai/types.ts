export type AiProvider = "codex" | "claude";

export interface AiModel {
	id: string;
	name: string;
}

export interface AiProviderView {
	description: string;
	id: AiProvider;
	models: AiModel[];
	name: string;
}

export interface AiAccountView {
	email?: string;
	enabled: boolean;
	expiresAt?: number;
	id: string;
	label: string;
	maxConcurrency: number;
	pool: AiAccountPoolView;
	priority: number;
	provider: AiProvider;
	source: "oauth" | "codex-cli" | "claude-cli" | "token";
	status: "connected" | "expired";
	weight: number;
}

/** Server-only credentials. Never send this type to the browser or journal. */
export interface AiCredential {
	accessToken: string;
	accountId?: string;
	authMode: "siwc" | "codex" | "claude";
	clientId: string;
	email?: string;
	enabled?: boolean;
	expiresAt?: number;
	id: string;
	idToken?: string;
	label: string;
	maxConcurrency?: number;
	priority?: number;
	provider: AiProvider;
	refreshToken?: string;
	scopes?: string[];
	source: AiAccountView["source"];
	subject?: string;
	weight?: number;
}

export interface AiState {
	accounts: AiAccountView[];
	providers: AiProviderView[];
	proxy: AiProxyView;
}

export interface AiUsageStats {
	completed: number;
	failed: number;
	inputTokens: number;
	outputTokens: number;
	requests: number;
}

export interface AiAccountPoolView extends AiUsageStats {
	active: number;
	cooldownUntil?: number;
	lastError?: string;
	lastLatencyMs?: number;
	status: "ready" | "disabled" | "cooldown" | "unauthorized";
}

export type AiRoutingStrategy = "round-robin" | "fill-first" | "least-busy";

export interface AiModelAlias {
	accountId?: string;
	id: string;
	model: string;
	provider: AiProvider;
}

export interface AiProxyConfig {
	aliases: AiModelAlias[];
	strategy: AiRoutingStrategy;
}

export interface AiProxyKeyView {
	allowedAccounts?: string[];
	allowedModels?: string[];
	allowedProviders?: AiProvider[];
	createdAt: number;
	enabled: boolean;
	expiresAt?: number;
	id: string;
	label: string;
	lastUsedAt?: number;
	prefix: string;
	requests: number;
	requestsPerMinute?: number;
}

/** A digest and access constraints, never the generated secret. */
export interface AiProxyKey
	extends Omit<AiProxyKeyView, "requests" | "lastUsedAt"> {
	digest: string;
}

export interface AiProxyView extends AiProxyConfig {
	keys: AiProxyKeyView[];
	stats: AiUsageStats;
}

export interface AiMessage {
	content: string;
	role: "system" | "user" | "assistant";
}

export interface AiChatRequest {
	accountId?: string;
	maxTokens?: number;
	messages: AiMessage[];
	model: string;
	provider?: AiProvider;
}

export type AiChatEvent =
	| { type: "route"; accountId: string; model: string; provider: AiProvider }
	| { type: "text"; text: string }
	| { type: "done"; usage?: { inputTokens: number; outputTokens: number } }
	| { type: "error"; error: string };

export interface AiOAuthStart {
	expiresAt: number;
	id: string;
	manual: boolean;
	url: string;
}

export interface AiOAuthStatus {
	error?: string;
	status: "pending" | "complete" | "error" | "expired";
}

export class AiError extends Error {
	readonly status: number;

	constructor(
		message: string,
		status: number | (ErrorOptions & { status: number }) = 400
	) {
		super(message, typeof status === "number" ? undefined : status);
		this.name = "AiError";
		this.status = typeof status === "number" ? status : status.status;
	}
}

/** Provider response bodies may contain credentials or prompts; keep errors deliberately bounded. */
export function safeAiError(error: unknown): { error: string; status: number } {
	if (error instanceof AiError) {
		return { error: error.message, status: error.status };
	}
	return {
		error: "Не удалось выполнить AI-запрос. Проверьте подключение и повторите.",
		status: 502,
	};
}
