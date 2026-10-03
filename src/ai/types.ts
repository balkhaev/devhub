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
	expiresAt?: number;
	id: string;
	label: string;
	provider: AiProvider;
	source: "oauth" | "codex-cli" | "claude-cli" | "token";
	status: "connected" | "expired";
}

/** Server-only credentials. Never send this type to the browser or journal. */
export interface AiCredential {
	accessToken: string;
	accountId?: string;
	authMode: "siwc" | "codex" | "claude";
	clientId: string;
	email?: string;
	expiresAt?: number;
	id: string;
	idToken?: string;
	label: string;
	provider: AiProvider;
	refreshToken?: string;
	scopes?: string[];
	source: AiAccountView["source"];
	subject?: string;
}

export interface AiState {
	accounts: AiAccountView[];
	providers: AiProviderView[];
}

export interface AiMessage {
	content: string;
	role: "system" | "user" | "assistant";
}

export interface AiChatRequest {
	accountId: string;
	maxTokens?: number;
	messages: AiMessage[];
	model: string;
}

export type AiChatEvent =
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
