import type { AiModelsInventory, AiProvider } from "../ai/types";

export type { AiState } from "../ai/types";

export interface AiOAuthFlow {
	expiresAt: number;
	id: string;
	manual: boolean;
	url: string;
}

export interface AiOAuthStatus {
	error?: string;
	status: "pending" | "complete" | "error" | "expired";
}

export interface AiModelList {
	error?: string;
	models: { id: string; name: string }[];
	source: "remote" | "catalog";
}

export interface AiMessage {
	content: string;
	role: "user" | "assistant" | "system";
}

export interface AiUsage {
	inputTokens: number;
	outputTokens: number;
}

export type AiStreamEvent =
	| { text: string; type: "text" }
	| { type: "route"; accountId: string; model: string; provider: AiProvider }
	| { type: "done"; usage?: AiUsage }
	| { error: string; type: "error" };

const HEADERS = { "Content-Type": "application/json", "x-devhub": "1" };

async function checkedResponse(response: Response): Promise<Response> {
	if (response.ok) {
		return response;
	}
	let error = `DevHub вернул HTTP ${response.status}`;
	try {
		const body: unknown = await response.json();
		if (
			body &&
			typeof body === "object" &&
			"error" in body &&
			typeof body.error === "string"
		) {
			({ error } = body);
		}
	} catch {
		// An HTML error page must not become a chat message.
	}
	throw new Error(error);
}

export async function aiRequest<T>(
	path: string,
	data?: unknown,
	signal?: AbortSignal
): Promise<T> {
	const response = await checkedResponse(
		await fetch(`/api/ai/${path}`, {
			body: data === undefined ? undefined : JSON.stringify(data),
			cache: "no-store",
			headers: HEADERS,
			method: data === undefined ? "GET" : "POST",
			signal,
		})
	);
	return response.json() as Promise<T>;
}

export function aiModels(
	refresh = false,
	signal?: AbortSignal
): Promise<AiModelsInventory> {
	return aiRequest<AiModelsInventory>(
		refresh ? "models?refresh=1" : "models",
		undefined,
		signal
	);
}

function streamEvent(line: string): AiStreamEvent {
	const value: unknown = JSON.parse(line);
	if (value && typeof value === "object" && "type" in value) {
		if (
			value.type === "route" &&
			"accountId" in value &&
			typeof value.accountId === "string" &&
			"model" in value &&
			typeof value.model === "string" &&
			"provider" in value &&
			(value.provider === "codex" || value.provider === "claude")
		) {
			return {
				accountId: value.accountId,
				model: value.model,
				provider: value.provider,
				type: "route",
			};
		}
		if (
			value.type === "text" &&
			"text" in value &&
			typeof value.text === "string"
		) {
			return { text: value.text, type: "text" };
		}
		if (value.type === "done") {
			return value as AiStreamEvent;
		}
		if (
			value.type === "error" &&
			"error" in value &&
			typeof value.error === "string"
		) {
			return { error: value.error, type: "error" };
		}
	}
	throw new Error("DevHub прислал неизвестное событие ответа");
}

/** NDJSON can split both JSON lines and UTF-8 characters across network chunks. */
export async function aiChat(
	data: {
		accountId?: string;
		provider?: AiProvider;
		maxTokens?: number;
		messages: AiMessage[];
		model: string;
	},
	onEvent: (event: AiStreamEvent) => void,
	signal: AbortSignal
): Promise<void> {
	const response = await checkedResponse(
		await fetch("/api/ai/chat", {
			body: JSON.stringify(data),
			headers: HEADERS,
			method: "POST",
			signal,
		})
	);
	if (!response.body) {
		throw new Error("DevHub не открыл поток ответа");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let complete = false;
	const emit = (line: string) => {
		if (!line.trim()) {
			return;
		}
		const event = streamEvent(line);
		if (event.type === "error") {
			throw new Error(event.error);
		}
		complete ||= event.type === "done";
		onEvent(event);
	};
	try {
		while (!complete) {
			// biome-ignore lint/performance/noAwaitInLoops: stream chunks must be decoded in their original order.
			const chunk = await reader.read();
			buffer += decoder.decode(chunk.value, { stream: !chunk.done });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				emit(line);
			}
			if (chunk.done) {
				emit(buffer);
				break;
			}
		}
		if (!complete) {
			throw new Error(
				"Поток оборвался до завершения ответа. Можно повторить запрос."
			);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
