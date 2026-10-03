import { createHash } from "node:crypto";
import { z } from "zod";
import {
	CompletionCollector,
	CompletionDecoder,
	type CompletionEvent,
	validateResponseEnvelope,
} from "./completion-stream";
import {
	boundedRequest,
	completionBody,
	completionSchema,
} from "./completions";
import { parseSseJson, readSse, type SseFrame } from "./stream";
import {
	type AiAccountModels,
	type AiChatEvent,
	type AiChatRequest,
	type AiCredential,
	AiError,
	type AiMessage,
	type AiModel,
	type AiProviderView,
	safeAiError,
} from "./types";

export const AI_PROVIDERS: AiProviderView[] = [
	{
		description:
			"Личная подписка ChatGPT: OAuth или локальная авторизация Codex CLI.",
		id: "codex",
		models: [
			{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
			{ id: "gpt-5.5", name: "GPT-5.5" },
			{ id: "gpt-5.4", name: "GPT-5.4" },
			{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
		],
		name: "OpenAI / Codex",
	},
	{
		description:
			"OAuth Claude. Доступ и списание квоты или кредитов из стороннего приложения определяет Anthropic.",
		id: "claude",
		models: [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-opus-4-6", name: "Claude Opus 4.6" },
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
		],
		name: "Claude",
	},
];

const MAX_TEXT = 262_144;
const modelSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const remoteModelSchema = z.object({
	display_name: z.string().max(2000).optional(),
	id: modelSchema.optional(),
	slug: modelSchema.optional(),
	supported_in_api: z.boolean().optional(),
	type: z.literal("model").optional(),
	visibility: z.string().max(100).optional(),
});
const claudeModelPageSchema = z.object({
	data: z.array(remoteModelSchema.extend({ id: modelSchema })).max(1000),
	has_more: z.boolean(),
	last_id: z.string().max(200).nullish(),
});
const chatGptModelPageSchema = z.object({
	has_more: z.literal(false).optional(),
	models: z.array(remoteModelSchema).max(1000),
});
const MAX_MODEL_PAGES = 10;
const MAX_MODEL_BYTES = 8_388_608;
const messageSchema = z
	.object({
		content: z.string().max(MAX_TEXT),
		role: z.enum(["system", "user", "assistant"]),
	})
	.strict();
const messagesSchema = z
	.array(messageSchema)
	.min(1)
	.max(100)
	.refine(
		(messages) =>
			messages.reduce(
				(size, message) => size + Buffer.byteLength(message.content, "utf8"),
				0
			) <= MAX_TEXT,
		"Слишком большой запрос"
	);
const chatSchema = z
	.object({
		accountId: z.string().min(1).max(200),
		maxTokens: z.number().int().min(1).max(131_072).optional(),
		messages: messagesSchema,
		model: modelSchema,
	})
	.strict();
const responsesSchema = z
	.object({
		background: z.boolean().optional(),
		include: z.array(z.string().max(200)).max(100).optional(),
		input: z.union([
			z.string().max(MAX_TEXT),
			z.array(z.unknown()).min(1).max(100),
		]),
		instructions: z.string().max(MAX_TEXT).optional(),
		max_output_tokens: z.number().int().min(1).max(131_072).optional(),
		metadata: z.unknown().optional(),
		model: modelSchema,
		parallel_tool_calls: z.boolean().optional(),
		previous_response_id: z.string().max(200).optional(),
		prompt_cache_key: z.string().max(200).optional(),
		prompt_cache_retention: z.enum(["in_memory", "24h"]).optional(),
		reasoning: z.unknown().optional(),
		safety_identifier: z.string().max(256).optional(),
		service_tier: z.string().max(50).optional(),
		store: z.boolean().optional(),
		stream: z.boolean().optional(),
		temperature: z.number().min(0).max(2).optional(),
		text: z.unknown().optional(),
		tool_choice: z.unknown().optional(),
		tools: z.array(z.unknown()).max(100).optional(),
		top_p: z.number().min(0).max(1).optional(),
		truncation: z.enum(["auto", "disabled"]).optional(),
	})
	.strict();
const anthropicSchema = z
	.object({
		container: z.unknown().optional(),
		context_management: z.unknown().optional(),
		max_tokens: z.number().int().min(1).max(131_072).optional(),
		messages: z
			.array(
				z
					.object({
						content: z.union([
							z.string().max(MAX_TEXT),
							z.array(z.unknown()).max(100),
						]),
						role: z.enum(["user", "assistant"]),
					})
					.strict()
			)
			.min(1)
			.max(100),
		metadata: z.unknown().optional(),
		model: modelSchema,
		output_config: z.unknown().optional(),
		service_tier: z.string().max(50).optional(),
		stop_sequences: z.array(z.string().max(200)).max(100).optional(),
		stream: z.boolean().optional(),
		system: z
			.union([z.string().max(MAX_TEXT), z.array(z.unknown()).max(100)])
			.optional(),
		temperature: z.number().min(0).max(1).optional(),
		thinking: z.unknown().optional(),
		tool_choice: z.unknown().optional(),
		tools: z.array(z.unknown()).max(100).optional(),
		top_k: z.number().int().min(0).optional(),
		top_p: z.number().min(0).max(1).optional(),
	})
	.strict();
const responseFields = [
	"model",
	"input",
	"instructions",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"reasoning",
	"text",
	"temperature",
	"top_p",
	"stream",
	"max_output_tokens",
	"metadata",
	"service_tier",
	"include",
	"previous_response_id",
	"prompt_cache_key",
	"prompt_cache_retention",
	"truncation",
	"background",
	"safety_identifier",
];
const anthropicFields = [
	"model",
	"messages",
	"max_tokens",
	"system",
	"stream",
	"temperature",
	"top_p",
	"top_k",
	"stop_sequences",
	"metadata",
	"tools",
	"tool_choice",
	"thinking",
	"output_config",
	"service_tier",
	"container",
	"context_management",
];
const encoder = new TextEncoder();

export interface AiLifecycleEvent {
	code?: string;
	credentialFingerprint?: string;
	kind: "complete" | "error" | "cancel";
	retryAfterMs?: number;
	status?: number;
	usage?: { inputTokens: number; outputTokens: number };
}
export type AiLifecycle = (event: AiLifecycleEvent) => void;

export class AiUpstreamError extends AiError {
	readonly upstreamStatus: number;
	readonly retryAfterMs?: number;
	readonly retryable: boolean;
	readonly code?: string;
	readonly credentialFingerprint?: string;

	constructor(
		message: string,
		upstreamStatus: number,
		retryAfterMs?: number,
		code?: string,
		retryable?: boolean,
		credentialFingerprint?: string
	) {
		super(message, upstreamErrorStatus(upstreamStatus));
		this.name = "AiUpstreamError";
		this.upstreamStatus = upstreamStatus;
		this.retryAfterMs = retryAfterMs;
		this.retryable =
			retryable ?? (upstreamStatus === 401 || upstreamStatus === 429);
		this.code = code;
		this.credentialFingerprint = credentialFingerprint;
	}
}

function upstreamErrorStatus(status: number): number {
	if ([401, 403, 429, 503].includes(status)) {
		return status;
	}
	return status >= 500 ? 502 : 400;
}

function retryAfter(responseHeaders: Headers): number | undefined {
	const value = responseHeaders.get("retry-after");
	if (!value) {
		return;
	}
	const seconds = Number(value);
	const ms = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(value) - Date.now();
	return Number.isFinite(ms) && ms >= 0
		? Math.min(Math.ceil(ms), 86_400_000)
		: undefined;
}

function lifecycleOnce(
	callback?: AiLifecycle
): (event: AiLifecycleEvent) => void {
	let ended = false;
	return (event) => {
		if (ended) {
			return;
		}
		ended = true;
		try {
			callback?.(event);
		} catch {
			/* Observers cannot change the upstream result. */
		}
	};
}

interface RequestContext {
	close: () => void;
	controller: AbortController;
	signal: AbortSignal;
}
interface PreparedRequest {
	context: RequestContext;
	credential: AiCredential;
	finish?: (event: AiLifecycleEvent) => void;
	response: Response;
}
const preparedUsage = new WeakMap<
	PreparedRequest,
	{ inputTokens: number; outputTokens: number }
>();
type BodyFactory = (credential: AiCredential) => Record<string, unknown>;

function bindLifecycle(
	prepared: PreparedRequest,
	callback?: AiLifecycle
): void {
	const notify = lifecycleOnce(callback);
	const credentialFingerprint = tokenFingerprint(prepared.credential);
	const onAbort = () => {
		const error = transportError(undefined, prepared.context);
		prepared.finish?.({
			kind: error.status === 499 ? "cancel" : "error",
			status: error.status,
		});
	};
	prepared.finish = (event) => {
		prepared.context.signal.removeEventListener("abort", onAbort);
		prepared.context.close();
		notify({ ...event, credentialFingerprint });
	};
	prepared.context.signal.addEventListener("abort", onAbort, { once: true });
	if (prepared.context.signal.aborted) {
		onAbort();
	}
}

function tokenFingerprint(credential: AiCredential): string {
	return createHash("sha256").update(credential.accessToken).digest("hex");
}

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		throw new AiError(
			"Некорректный AI-запрос: проверьте модель, сообщения и поддерживаемые параметры.",
			400
		);
	}
	return parsed.data;
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function boundedNativeBody(value: Record<string, unknown>): void {
	boundedRequest(value);
}

function selectFields(
	input: Record<string, unknown>,
	fields: string[]
): Record<string, unknown> {
	return Object.fromEntries(
		fields
			.filter((field) => input[field] !== undefined)
			.map((field) => [field, input[field]])
	);
}

function createContext(
	signal?: AbortSignal,
	duration = 180_000
): RequestContext {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(new AiError("Превышено время ожидания AI-ответа.", 504)),
		duration
	);
	return {
		close: () => clearTimeout(timer),
		controller,
		signal: signal
			? AbortSignal.any([signal, controller.signal])
			: controller.signal,
	};
}

function requestError(
	status: number,
	credential: AiCredential,
	delay?: number
): AiUpstreamError {
	if (status === 401) {
		return new AiUpstreamError(
			"Авторизация истекла. Подключите аккаунт заново.",
			401,
			delay,
			undefined,
			undefined,
			tokenFingerprint(credential)
		);
	}
	if (status === 403) {
		return new AiUpstreamError(
			credential.provider === "claude"
				? "Anthropic не разрешил запрос. Личная подписка Claude может запрещать OAuth-доступ из стороннего приложения; успешное подключение не гарантирует доступ к моделям."
				: "OpenAI не разрешил запрос. Проверьте подписку и доступ аккаунта к выбранной модели.",
			403,
			delay,
			undefined,
			undefined,
			tokenFingerprint(credential)
		);
	}
	if (status === 429) {
		return new AiUpstreamError(
			"Лимит провайдера исчерпан. Повторите запрос позже.",
			429,
			delay,
			undefined,
			undefined,
			tokenFingerprint(credential)
		);
	}
	return new AiUpstreamError(
		"Провайдер отклонил AI-запрос. Проверьте модель и параметры.",
		status,
		delay,
		undefined,
		undefined,
		tokenFingerprint(credential)
	);
}

function transportError(
	error: unknown,
	context: RequestContext,
	credential?: AiCredential
): AiError {
	if (context.signal.aborted) {
		return context.signal.reason instanceof AiError
			? context.signal.reason
			: new AiError("AI-запрос отменён.", 499);
	}
	if (
		error instanceof AiUpstreamError &&
		credential &&
		!error.credentialFingerprint
	) {
		return new AiUpstreamError(
			error.message,
			error.upstreamStatus,
			error.retryAfterMs,
			error.code,
			error.retryable,
			tokenFingerprint(credential)
		);
	}
	return error instanceof AiError
		? error
		: new AiError("Не удалось получить ответ от AI-провайдера.", 502);
}

function headers(credential: AiCredential): Headers {
	const value = new Headers({
		Authorization: `Bearer ${credential.accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "DevHub/0.1",
	});
	if (credential.authMode === "claude") {
		value.set("anthropic-beta", "oauth-2025-04-20");
		value.set("anthropic-version", "2023-06-01");
	} else if (credential.authMode === "codex" && credential.accountId) {
		value.set("chatgpt-account-id", credential.accountId);
	}
	return value;
}

function endpoint(credential: AiCredential, models = false): string {
	if (credential.authMode === "claude") {
		return `https://api.anthropic.com/v1/${models ? "models" : "messages"}`;
	}
	if (credential.authMode === "codex") {
		return `https://chatgpt.com/backend-api/codex/${models ? "models?client_version=0.156.1" : "responses"}`;
	}
	return `https://api.openai.com/v1/${models ? "models" : "responses"}`;
}

function modelsEndpoint(credential: AiCredential, cursor?: string): string {
	const url = new URL(endpoint(credential, true));
	if (credential.authMode === "claude") {
		url.searchParams.set("limit", "1000");
		if (cursor) {
			url.searchParams.set("after_id", cursor);
		}
	}
	return url.toString();
}

function invalidModelCatalog(): never {
	throw new AiError(
		"Провайдер вернул некорректный или неполный список моделей.",
		502
	);
}

async function readModelPayload(prepared: PreparedRequest): Promise<unknown> {
	const { body } = prepared.response;
	if (!body) {
		return invalidModelCatalog();
	}
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const cancel = () => {
		reader.cancel().catch(() => undefined);
	};
	prepared.context.signal.addEventListener("abort", cancel, { once: true });
	try {
		let size = 0;
		let text = "";
		let ended = false;
		while (!ended) {
			prepared.context.signal.throwIfAborted();
			// biome-ignore lint/performance/noAwaitInLoops: catalog packets must be read in order.
			const packet = await reader.read();
			prepared.context.signal.throwIfAborted();
			size += packet.value?.byteLength ?? 0;
			if (size > MAX_MODEL_BYTES) {
				return invalidModelCatalog();
			}
			ended = packet.done;
			text += decoder.decode(packet.value, { stream: !ended });
		}
		return JSON.parse(text);
	} catch (error) {
		if (prepared.context.signal.aborted) {
			throw transportError(error, prepared.context);
		}
		return invalidModelCatalog();
	} finally {
		prepared.context.signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function normalizeRemoteModels(
	items: z.infer<typeof remoteModelSchema>[],
	credential: AiCredential
): AiModel[] {
	return items.flatMap((item): AiModel[] => {
		const id =
			credential.authMode === "claude" ? item.id : (item.slug ?? item.id);
		if (
			!id ||
			(credential.authMode === "siwc" && !item.slug) ||
			(credential.authMode === "claude" && !id.startsWith("claude-"))
		) {
			return invalidModelCatalog();
		}
		if (
			item.supported_in_api === false ||
			item.visibility === "hide" ||
			item.visibility === "hidden" ||
			(credential.authMode === "siwc" && item.visibility !== "list")
		) {
			return [];
		}
		return [{ id, name: item.display_name?.trim().slice(0, 200) || id }];
	});
}

function modelPage(
	payload: unknown,
	credential: AiCredential
): { models: AiModel[]; cursor?: string } {
	if (credential.authMode !== "claude") {
		const parsed = chatGptModelPageSchema.safeParse(payload);
		const record = object(payload);
		if (
			!parsed.success ||
			record.error ||
			record.next_page ||
			record.next_cursor
		) {
			return invalidModelCatalog();
		}
		return { models: normalizeRemoteModels(parsed.data.models, credential) };
	}
	const parsed = claudeModelPageSchema.safeParse(payload);
	if (!parsed.success || object(payload).error) {
		return invalidModelCatalog();
	}
	const page = parsed.data;
	const models = normalizeRemoteModels(page.data, credential);
	if (!page.has_more) {
		return { models };
	}
	if (
		!(page.last_id && modelSchema.safeParse(page.last_id).success) ||
		page.last_id !== page.data.at(-1)?.id
	) {
		return invalidModelCatalog();
	}
	return { cursor: page.last_id, models };
}

function adaptResponses(
	body: Record<string, unknown>,
	credential: AiCredential
): Record<string, unknown> {
	// Both ChatGPT plan usage and the legacy Codex endpoint require upstream streaming.
	const result: Record<string, unknown> = {
		...body,
		store: false,
		stream: true,
	};
	if (credential.authMode === "siwc") {
		for (const field of [
			"background",
			"conversation",
			"max_output_tokens",
			"max_tool_calls",
			"metadata",
			"moderation",
			"multi_agent",
			"prompt",
			"prompt_cache_retention",
			"safety_identifier",
			"temperature",
			"top_logprobs",
			"top_p",
			"truncation",
			"user",
			"previous_response_id",
		]) {
			if (result[field] !== undefined) {
				throw new AiError(
					`Подписка ChatGPT не поддерживает ${field} в HTTP Responses. Удалите этот параметр.`,
					400
				);
			}
		}
		if (typeof result.input === "string") {
			result.input = [{ content: result.input, role: "user" }];
		}
		if (Array.isArray(result.tools)) {
			const grouped = siwcTools(result.tools);
			result.tools = grouped.tools;
			if (grouped.namespace && Array.isArray(result.input)) {
				result.input = namespacedHistory(
					result.input,
					grouped.namespace,
					grouped.flatNames
				);
			}
		}
	}
	if (credential.authMode === "codex") {
		result.instructions =
			typeof result.instructions === "string" ? result.instructions : "";
		for (const field of [
			"max_output_tokens",
			"truncation",
			"background",
			"temperature",
			"top_p",
		]) {
			delete result[field];
		}
	}
	if (Array.isArray(result.input)) {
		result.input = result.input.map((item: unknown) => {
			const message = object(item);
			return message.role === "system"
				? { ...message, role: "developer" }
				: item;
		});
	}
	return result;
}

function namespacedHistory(
	input: unknown[],
	namespace: string,
	names: Set<string>
): unknown[] {
	return input.map((raw) => {
		const item = object(raw);
		return ["function_call", "custom_tool_call"].includes(String(item.type)) &&
			item.namespace === undefined &&
			typeof item.name === "string" &&
			names.has(item.name)
			? { ...item, namespace }
			: raw;
	});
}

function siwcTools(tools: unknown[]): {
	tools: unknown[];
	namespace?: string;
	flatNames: Set<string>;
} {
	const flat: unknown[] = [];
	const flatNames = new Set<string>();
	const grouped: unknown[] = [];
	for (const raw of tools) {
		const tool = object(raw);
		if (tool.type === "function" || tool.type === "custom") {
			flat.push(raw);
			if (typeof tool.name === "string") {
				flatNames.add(tool.name);
			}
			continue;
		}
		if (tool.type === "namespace") {
			if (
				!Array.isArray(tool.tools) ||
				tool.tools.some(
					(child) =>
						!["function", "custom"].includes(String(object(child).type))
				)
			) {
				throw new AiError(
					"Подписка ChatGPT поддерживает в namespace только function/custom tools.",
					400
				);
			}
			grouped.push(raw);
			continue;
		}
		if (tool.type === "web_search" || tool.type === "web_search_preview") {
			grouped.push(raw);
			continue;
		}
		throw new AiError(
			"Этот инструмент не поддерживается доступом через подписку ChatGPT.",
			400
		);
	}
	if (flat.length) {
		let name = "devhub";
		while (grouped.some((tool) => object(tool).name === name)) {
			name += "_functions";
		}
		grouped.push({ name, tools: flat, type: "namespace" });
		return { flatNames, namespace: name, tools: grouped };
	}
	return { flatNames, tools: grouped };
}

function chatBody(
	input: AiChatRequest,
	credential: AiCredential,
	options: Record<string, unknown> = {}
): Record<string, unknown> {
	if (credential.provider === "claude") {
		const system = input.messages
			.filter((message) => message.role === "system")
			.map((message) => message.content)
			.join("\n\n");
		const messages = input.messages.filter(
			(message) => message.role !== "system"
		);
		if (messages.length === 0) {
			throw new AiError(
				"Claude требует хотя бы одно сообщение пользователя или ассистента.",
				400
			);
		}
		return {
			messages,
			model: input.model,
			...(system ? { system } : {}),
			max_tokens: input.maxTokens ?? 4096,
			...options,
			stream: true,
		};
	}
	return adaptResponses(
		{
			input: input.messages.map((message: AiMessage) => ({
				content: [
					{
						text: message.content,
						type: message.role === "assistant" ? "output_text" : "input_text",
					},
				],
				role: message.role === "system" ? "developer" : message.role,
			})),
			model: input.model,
			...(input.maxTokens ? { max_output_tokens: input.maxTokens } : {}),
			...options,
			stream: true,
		},
		credential
	);
}

function usage(value: unknown): { inputTokens: number; outputTokens: number } {
	const data = object(value);
	return {
		inputTokens:
			typeof data.input_tokens === "number" &&
			Number.isFinite(data.input_tokens)
				? data.input_tokens
				: 0,
		outputTokens:
			typeof data.output_tokens === "number" &&
			Number.isFinite(data.output_tokens)
				? data.output_tokens
				: 0,
	};
}

function eventType(frame: SseFrame, event: Record<string, unknown>): string {
	return typeof event.type === "string" ? event.type : (frame.event ?? "");
}

function providerStreamError(
	type: string,
	event: Record<string, unknown>
): void {
	if (
		type === "error" ||
		type === "response.failed" ||
		type === "response.incomplete" ||
		event.error ||
		object(event.response).error
	) {
		const providerError = object(object(event.response).error ?? event.error);
		const rawCode = providerError.code ?? providerError.type;
		const codes: Record<string, number> = {
			authentication_error: 401,
			chatpass_v2_invalid_authorization_context: 403,
			chatpass_v2_scope_not_authorized: 403,
			overloaded_error: 529,
			permission_error: 403,
			rate_limit_error: 429,
			subscription_sharing_invalid_user: 401,
			subscription_sharing_route_not_supported: 403,
			subscription_sharing_unsupported_capability: 400,
			subscription_sharing_usage_limit_exceeded: 429,
			subscription_sharing_usage_unavailable: 503,
			subscription_sharing_user_not_eligible: 403,
			subscription_sharing_user_unavailable: 503,
		};
		const code =
			typeof rawCode === "string" && Object.hasOwn(codes, rawCode)
				? rawCode
				: "provider_error";
		throw new AiUpstreamError(
			"Провайдер не завершил AI-ответ. Повторите запрос или измените параметры.",
			codes[code] ?? 502,
			undefined,
			code,
			false
		);
	}
}

function decodeClaude(
	type: string,
	event: Record<string, unknown>,
	tokens: { inputTokens: number; outputTokens: number }
): AiChatEvent | undefined {
	if (type === "message_start") {
		({ inputTokens: tokens.inputTokens } = usage(object(event.message).usage));
	} else if (type === "message_delta") {
		({ outputTokens: tokens.outputTokens } = usage(event.usage));
	} else if (type === "message_stop") {
		return { type: "done", usage: { ...tokens } };
	} else if (type === "content_block_delta") {
		const delta = object(event.delta);
		if (delta.type === "text_delta" && typeof delta.text === "string") {
			return { text: delta.text, type: "text" };
		}
	}
}

function decodeOpenAI(
	type: string,
	event: Record<string, unknown>
): AiChatEvent | undefined {
	if (
		type === "response.output_text.delta" &&
		typeof event.delta === "string"
	) {
		return { text: event.delta, type: "text" };
	}
	if (type === "response.completed") {
		validateResponseEnvelope(event.response);
		return { type: "done", usage: usage(object(event.response).usage) };
	}
}

async function* normalizedEvents(
	prepared: PreparedRequest
): AsyncGenerator<AiChatEvent> {
	const { response, context, credential } = prepared;
	if (!response.body) {
		throw new AiError("Провайдер вернул пустой ответ.", 502);
	}
	const tokens = { inputTokens: 0, outputTokens: 0 };
	for await (const frame of readSse(response.body, context.signal)) {
		const event = parseSseJson(frame);
		if (!event) {
			continue;
		}
		const type = eventType(frame, event);
		providerStreamError(type, event);
		const decoded =
			credential.provider === "claude"
				? decodeClaude(type, event, tokens)
				: decodeOpenAI(type, event);
		if (!decoded) {
			continue;
		}
		yield decoded;
		if (decoded.type === "done") {
			return;
		}
	}
	throw new AiError(
		"Соединение с провайдером оборвалось до завершения AI-ответа.",
		502
	);
}

function streamResponse(
	prepared: PreparedRequest,
	produce: () => AsyncGenerator<string>,
	contentType: string,
	errorFormat: (error: AiError) => string
): Response {
	const iterator = produce();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		async cancel() {
			cancelled = true;
			prepared.context.controller.abort();
			prepared.context.close();
			prepared.finish?.({ kind: "cancel", status: 499 });
			if (prepared.response.body && !prepared.response.body.locked) {
				await prepared.response.body.cancel().catch(() => undefined);
			}
			await iterator.return(undefined);
		},
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (cancelled) {
					return;
				}
				if (next.done) {
					prepared.context.close();
					controller.close();
				} else {
					controller.enqueue(encoder.encode(next.value));
				}
			} catch (error) {
				prepared.context.close();
				if (!cancelled) {
					const safe = transportError(error, prepared.context);
					prepared.finish?.({
						kind: safe.status === 499 ? "cancel" : "error",
						status:
							safe instanceof AiUpstreamError
								? safe.upstreamStatus
								: safe.status,
						...(safe instanceof AiUpstreamError
							? { code: safe.code, retryAfterMs: safe.retryAfterMs }
							: {}),
					});
					controller.enqueue(encoder.encode(errorFormat(safe)));
					controller.close();
				}
			}
		},
	});
	return new Response(stream, {
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": contentType,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function* completionEvents(
	prepared: PreparedRequest
): AsyncGenerator<CompletionEvent> {
	if (!prepared.response.body) {
		throw new AiError("Провайдер вернул пустой ответ.", 502);
	}
	const decoder = new CompletionDecoder(
		prepared.credential.provider === "claude"
	);
	for await (const frame of readSse(
		prepared.response.body,
		prepared.context.signal
	)) {
		const event = parseSseJson(frame);
		if (!event) {
			continue;
		}
		const type = eventType(frame, event);
		const limited =
			type === "response.incomplete" &&
			object(object(event.response).incomplete_details).reason ===
				"max_output_tokens" &&
			!object(event.response).error &&
			!event.error;
		if (!limited) {
			providerStreamError(type, event);
		}
		for (const decoded of decoder.feed(type, event)) {
			yield decoded;
			if (decoded.done) {
				return;
			}
		}
	}
	throw new AiError(
		"Соединение с провайдером оборвалось до завершения AI-ответа.",
		502
	);
}

function sse(data: unknown, event?: string): string {
	return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function validateClaudeMessage(value: unknown): void {
	const payload = object(value);
	if (
		payload.error ||
		payload.type !== "message" ||
		typeof payload.id !== "string" ||
		!Array.isArray(payload.content) ||
		![
			"end_turn",
			"max_tokens",
			"stop_sequence",
			"tool_use",
			"pause_turn",
			"refusal",
			"model_context_window_exceeded",
		].includes(String(payload.stop_reason))
	) {
		throw new AiError("Провайдер вернул некорректный AI-ответ.", 502);
	}
}

function updateNativeUsage(
	prepared: PreparedRequest,
	type: string,
	event: Record<string, unknown>
): void {
	if (type === "message_start") {
		preparedUsage.set(prepared, usage(object(event.message).usage));
	}
	if (type === "response.completed") {
		preparedUsage.set(prepared, usage(object(event.response).usage));
	}
	if (type === "message_delta") {
		const previous = preparedUsage.get(prepared) ?? usage({});
		const next = object(event.usage);
		preparedUsage.set(prepared, {
			inputTokens:
				typeof next.input_tokens === "number"
					? next.input_tokens
					: previous.inputTokens,
			outputTokens:
				typeof next.output_tokens === "number"
					? next.output_tokens
					: previous.outputTokens,
		});
	}
}

async function* nativeStream(
	prepared: PreparedRequest
): AsyncGenerator<string> {
	if (!prepared.response.body) {
		throw new AiError("Провайдер вернул пустой ответ.", 502);
	}
	const terminal =
		prepared.credential.provider === "claude"
			? "message_stop"
			: "response.completed";
	for await (const frame of readSse(
		prepared.response.body,
		prepared.context.signal
	)) {
		const event = parseSseJson(frame);
		if (!event) {
			continue;
		}
		const type = eventType(frame, event);
		providerStreamError(type, event);
		updateNativeUsage(prepared, type, event);
		if (type === "response.completed") {
			validateResponseEnvelope(event.response);
		}
		if (type === terminal) {
			prepared.finish?.({
				kind: "complete",
				status: 200,
				usage: preparedUsage.get(prepared),
			});
		}
		yield sse(event, frame.event);
		if (type === terminal) {
			return;
		}
	}
	throw new AiError(
		"Соединение с провайдером оборвалось до завершения AI-ответа.",
		502
	);
}

async function* completionStream(
	prepared: PreparedRequest,
	chunk: (
		delta: Record<string, unknown>,
		finishReason?: string | null
	) => Record<string, unknown>,
	includeUsage: boolean
): AsyncGenerator<string> {
	yield sse(chunk({ role: "assistant" }));
	for await (const event of completionEvents(prepared)) {
		if (event.delta) {
			yield sse(chunk(event.delta));
		}
		if (event.done) {
			prepared.finish?.({
				kind: "complete",
				status: 200,
				usage: event.usage
					? {
							inputTokens: event.usage.prompt_tokens,
							outputTokens: event.usage.completion_tokens,
						}
					: undefined,
			});
			yield sse(chunk({}, event.finishReason ?? "stop"));
			if (includeUsage && event.usage) {
				yield sse({ ...chunk({}), choices: [], usage: event.usage });
			}
			yield "data: [DONE]\n\n";
		}
	}
}

export class AiInference {
	private readonly credential: (
		id: string,
		forceRefresh?: boolean
	) => Promise<AiCredential>;
	private readonly fetcher: typeof globalThis.fetch;

	constructor(options: {
		credential: (id: string, forceRefresh?: boolean) => Promise<AiCredential>;
		fetch?: typeof globalThis.fetch;
	}) {
		this.credential = options.credential;
		this.fetcher = options.fetch ?? globalThis.fetch;
	}

	private async requestCredential(
		accountId: string,
		forceRefresh = false
	): Promise<AiCredential> {
		try {
			return await this.credential(accountId, forceRefresh);
		} catch (error) {
			if (
				error instanceof AiError &&
				(error.status === 401 || error.status === 429)
			) {
				// biome-ignore lint/style/useErrorCause: credential errors may contain secrets; preserve only a safe routing status.
				throw new AiUpstreamError(
					error.status === 401
						? "Авторизация истекла. Подключите аккаунт заново."
						: "Лимит обновления авторизации исчерпан. Повторите позже.",
					error.status
				);
			}
			throw error;
		}
	}

	private async request(
		accountId: string,
		signal: AbortSignal | undefined,
		body?: BodyFactory,
		options?: { credential?: AiCredential; modelsCursor?: string }
	): Promise<PreparedRequest> {
		const context = createContext(signal, body ? 180_000 : 30_000);
		try {
			let credential =
				options?.credential ?? (await this.requestCredential(accountId));
			for (let attempt = 0; attempt < 2; attempt += 1) {
				context.signal.throwIfAborted();
				// biome-ignore lint/performance/noAwaitInLoops: retry only after the first authorization failure.
				const response = await this.fetcher(
					body
						? endpoint(credential)
						: modelsEndpoint(credential, options?.modelsCursor),
					{
						headers: headers(credential),
						method: body ? "POST" : "GET",
						...(body ? { body: JSON.stringify(body(credential)) } : {}),
						redirect: "error",
						signal: context.signal,
					}
				);
				if (response.ok) {
					return { context, credential, response };
				}
				await response.body?.cancel().catch(() => undefined);
				if (response.status === 401 && attempt === 0) {
					credential = await this.requestCredential(accountId, true);
					continue;
				}
				throw requestError(
					response.status,
					credential,
					retryAfter(response.headers)
				);
			}
			throw new AiError("Не удалось авторизовать AI-запрос.", 401);
		} catch (error) {
			context.close();
			throw transportError(error, context);
		}
	}

	async models(
		accountId: string,
		signal?: AbortSignal
	): Promise<AiAccountModels> {
		const context = createContext(signal, 30_000);
		let credential: AiCredential | undefined;
		try {
			credential = await this.requestCredential(accountId);
			const models = new Map<string, AiModel>();
			const cursors = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
				context.signal.throwIfAborted();
				// biome-ignore lint/performance/noAwaitInLoops: provider cursors depend on the preceding complete page.
				const prepared = await this.request(
					accountId,
					context.signal,
					undefined,
					{ credential, modelsCursor: cursor }
				);
				let next: ReturnType<typeof modelPage>;
				try {
					({ credential } = prepared);
					next = modelPage(await readModelPayload(prepared), credential);
				} finally {
					prepared.context.close();
				}
				for (const model of next.models) {
					if (!models.has(model.id)) {
						models.set(model.id, model);
					}
				}
				if (!next.cursor) {
					return { models: [...models.values()], source: "remote" };
				}
				if (cursors.has(next.cursor)) {
					return invalidModelCatalog();
				}
				cursors.add(next.cursor);
				({ cursor } = next);
			}
			return invalidModelCatalog();
		} catch (error) {
			if (signal?.aborted) {
				// biome-ignore lint/style/useErrorCause: cancellation is sanitized without provider data in its cause.
				throw new AiError("AI-запрос отменён.", 499);
			}
			const failure = safeAiError(transportError(error, context));
			const catalog =
				AI_PROVIDERS.find((provider) => provider.id === credential?.provider)
					?.models ?? [];
			return {
				error: failure.error,
				models: catalog.map((model) => ({ ...model })),
				source: "catalog",
				status: failure.status,
			};
		} finally {
			context.close();
		}
	}
	async chat(
		input: AiChatRequest,
		signal: AbortSignal,
		lifecycle?: AiLifecycle
	): Promise<Response> {
		const parsed = validate(chatSchema, input);
		const prepared = await this.request(
			parsed.accountId,
			signal,
			(credential) => chatBody(parsed, credential)
		);
		bindLifecycle(prepared, lifecycle);
		return streamResponse(
			prepared,
			async function* () {
				for await (const event of normalizedEvents(prepared)) {
					if (event.type === "done") {
						prepared.finish?.({
							kind: "complete",
							status: 200,
							usage: event.usage,
						});
					}
					yield `${JSON.stringify(event)}\n`;
				}
			},
			"application/x-ndjson; charset=utf-8",
			(error) =>
				`${JSON.stringify({ error: error.message, type: "error", ...(error instanceof AiUpstreamError ? { code: error.code } : {}) })}\n`
		);
	}

	async gateway(
		path: "/v1/chat/completions" | "/v1/responses" | "/v1/messages",
		body: unknown,
		accountId: string,
		signal: AbortSignal,
		lifecycle?: AiLifecycle
	): Promise<Response> {
		if (path === "/v1/chat/completions") {
			return await this.completions(body, accountId, signal, lifecycle);
		}
		if (path !== "/v1/responses" && path !== "/v1/messages") {
			throw new AiError("Неподдерживаемый AI-метод.", 404);
		}
		const parsed =
			path === "/v1/responses"
				? validate(responsesSchema, body)
				: validate(anthropicSchema, body);
		boundedNativeBody(parsed);
		const credential = await this.requestCredential(accountId);
		if ((path === "/v1/messages") !== (credential.provider === "claude")) {
			throw new AiError(
				"Этот AI-метод не поддерживается выбранным провайдером.",
				400
			);
		}
		if (
			credential.authMode === "codex" &&
			[
				"max_output_tokens",
				"temperature",
				"top_p",
				"truncation",
				"background",
			].some((field) => object(parsed)[field] !== undefined)
		) {
			throw new AiError(
				"Codex CLI не поддерживает max_output_tokens, temperature, top_p, truncation и background в этом методе.",
				400
			);
		}
		const wantsStream = parsed.stream === true;
		const prepared = await this.request(accountId, signal, (current) =>
			path === "/v1/responses"
				? adaptResponses(selectFields(parsed, responseFields), current)
				: {
						...selectFields(parsed, anthropicFields),
						max_tokens: object(parsed).max_tokens ?? 4096,
						stream: wantsStream,
					}
		);
		if (!wantsStream && prepared.credential.authMode === "claude") {
			try {
				const payload: unknown = await prepared.response.json();
				validateClaudeMessage(payload);
				const result = Response.json(payload, {
					headers: { "Cache-Control": "no-store" },
				});
				lifecycleOnce(lifecycle)({
					credentialFingerprint: tokenFingerprint(prepared.credential),
					kind: "complete",
					status: 200,
					usage: usage(object(payload).usage),
				});
				return result;
			} catch (error) {
				throw transportError(error, prepared.context, prepared.credential);
			} finally {
				prepared.context.close();
			}
		}
		if (!wantsStream) {
			const result = await this.collectNativeResponses(prepared);
			lifecycleOnce(lifecycle)({
				credentialFingerprint: tokenFingerprint(prepared.credential),
				kind: "complete",
				status: 200,
				usage: preparedUsage.get(prepared),
			});
			return result;
		}
		bindLifecycle(prepared, lifecycle);
		return streamResponse(
			prepared,
			() => nativeStream(prepared),
			"text/event-stream; charset=utf-8",
			(error) =>
				sse(
					{
						error: {
							message: error.message,
							type: "api_error",
							...(error instanceof AiUpstreamError ? { code: error.code } : {}),
						},
						type: "error",
					},
					"error"
				)
		);
	}

	private async collectNativeResponses(
		prepared: PreparedRequest
	): Promise<Response> {
		try {
			if (!prepared.response.body) {
				throw new AiError("Провайдер вернул пустой ответ.", 502);
			}
			for await (const frame of readSse(
				prepared.response.body,
				prepared.context.signal
			)) {
				const event = parseSseJson(frame);
				if (!event) {
					continue;
				}
				const type = eventType(frame, event);
				providerStreamError(type, event);
				if (type === "response.completed" && event.response) {
					validateResponseEnvelope(event.response);
					preparedUsage.set(prepared, usage(object(event.response).usage));
					return Response.json(event.response, {
						headers: { "Cache-Control": "no-store" },
					});
				}
			}
			throw new AiError(
				"Соединение с провайдером оборвалось до завершения AI-ответа.",
				502
			);
		} catch (error) {
			throw transportError(error, prepared.context, prepared.credential);
		} finally {
			prepared.context.close();
		}
	}

	private async completions(
		body: unknown,
		accountId: string,
		signal: AbortSignal,
		lifecycle?: AiLifecycle
	): Promise<Response> {
		const parsed = validate(completionSchema, body);
		const prepared = await this.request(accountId, signal, (credential) =>
			completionBody(parsed, credential)
		);
		const id = `chatcmpl-${crypto.randomUUID()}`;
		const created = Math.floor(Date.now() / 1000);
		const chunk = (
			delta: Record<string, unknown>,
			finishReason: string | null = null
		) => ({
			choices: [{ delta, finish_reason: finishReason, index: 0 }],
			created,
			id,
			model: parsed.model,
			object: "chat.completion.chunk",
		});
		if (parsed.stream) {
			bindLifecycle(prepared, lifecycle);
			return streamResponse(
				prepared,
				() =>
					completionStream(
						prepared,
						chunk,
						parsed.stream_options?.include_usage === true
					),
				"text/event-stream; charset=utf-8",
				(error) =>
					sse({
						error: {
							code:
								error instanceof AiUpstreamError
									? (error.code ?? "provider_error")
									: "provider_error",
							message: error.message,
							type: "api_error",
						},
					})
			);
		}
		try {
			const collector = new CompletionCollector();
			for await (const event of completionEvents(prepared)) {
				collector.accept(event);
			}
			const result = Response.json(
				{
					choices: [
						{
							finish_reason: collector.finishReason,
							index: 0,
							message: collector.message(),
						},
					],
					created,
					id,
					model: parsed.model,
					object: "chat.completion",
					usage: collector.usage,
				},
				{ headers: { "Cache-Control": "no-store" } }
			);
			lifecycleOnce(lifecycle)({
				credentialFingerprint: tokenFingerprint(prepared.credential),
				kind: "complete",
				status: 200,
				usage: {
					inputTokens: collector.usage.prompt_tokens,
					outputTokens: collector.usage.completion_tokens,
				},
			});
			return result;
		} catch (error) {
			throw transportError(error, prepared.context, prepared.credential);
		} finally {
			prepared.context.close();
		}
	}
}
