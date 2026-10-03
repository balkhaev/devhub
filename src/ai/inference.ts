import { z } from "zod";
import { parseSseJson, readSse, type SseFrame } from "./stream";
import {
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
const completionSchema = z
	.object({
		max_completion_tokens: z.number().int().min(1).max(131_072).optional(),
		max_tokens: z.number().int().min(1).max(131_072).optional(),
		messages: messagesSchema,
		model: modelSchema,
		stream: z.boolean().optional(),
		stream_options: z
			.object({ include_usage: z.boolean().optional() })
			.strict()
			.optional(),
		temperature: z.number().min(0).max(2).optional(),
		top_p: z.number().min(0).max(1).optional(),
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

interface RequestContext {
	close: () => void;
	controller: AbortController;
	signal: AbortSignal;
}
interface PreparedRequest {
	context: RequestContext;
	credential: AiCredential;
	response: Response;
}
type BodyFactory = (credential: AiCredential) => Record<string, unknown>;

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
	if (JSON.stringify(value).length > MAX_TEXT) {
		throw new AiError("AI-запрос превышает допустимый размер 256 КБ.", 413);
	}
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

function requestError(status: number, credential: AiCredential): AiError {
	if (status === 401) {
		return new AiError("Авторизация истекла. Подключите аккаунт заново.", 401);
	}
	if (status === 403) {
		return new AiError(
			credential.provider === "claude"
				? "Anthropic не разрешил запрос. Личная подписка Claude может запрещать OAuth-доступ из стороннего приложения; успешное подключение не гарантирует доступ к моделям."
				: "OpenAI не разрешил запрос. Проверьте подписку и доступ аккаунта к выбранной модели.",
			403
		);
	}
	if (status === 429) {
		return new AiError(
			"Лимит провайдера исчерпан. Повторите запрос позже.",
			429
		);
	}
	return new AiError(
		"Провайдер отклонил AI-запрос. Проверьте модель и параметры.",
		status >= 500 ? 502 : 400
	);
}

function transportError(error: unknown, context: RequestContext): AiError {
	if (context.signal.aborted) {
		return context.signal.reason instanceof AiError
			? context.signal.reason
			: new AiError("AI-запрос отменён.", 499);
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
		if (Array.isArray(result.input)) {
			result.input = result.input.map((item: unknown) => {
				const message = object(item);
				return message.role === "system"
					? { ...message, role: "developer" }
					: item;
			});
		}
	}
	return result;
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
		throw new AiError(
			"Провайдер не завершил AI-ответ. Повторите запрос или измените параметры.",
			502
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
	errorFormat: (error: string) => string
): Response {
	const iterator = produce();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		async cancel() {
			cancelled = true;
			prepared.context.controller.abort();
			prepared.context.close();
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
					controller.enqueue(
						encoder.encode(
							errorFormat(
								safeAiError(transportError(error, prepared.context)).error
							)
						)
					);
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

function sse(data: unknown, event?: string): string {
	return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
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

	private async request(
		accountId: string,
		signal: AbortSignal | undefined,
		body?: BodyFactory
	): Promise<PreparedRequest> {
		const context = createContext(signal, body ? 180_000 : 30_000);
		try {
			let credential = await this.credential(accountId);
			for (let attempt = 0; attempt < 2; attempt += 1) {
				context.signal.throwIfAborted();
				// biome-ignore lint/performance/noAwaitInLoops: retry only after the first authorization failure.
				const response = await this.fetcher(endpoint(credential, !body), {
					headers: headers(credential),
					method: body ? "POST" : "GET",
					...(body ? { body: JSON.stringify(body(credential)) } : {}),
					redirect: "error",
					signal: context.signal,
				});
				if (response.ok) {
					return { context, credential, response };
				}
				await response.body?.cancel().catch(() => undefined);
				if (response.status === 401 && attempt === 0) {
					credential = await this.credential(accountId, true);
					continue;
				}
				throw requestError(response.status, credential);
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
	): Promise<{
		models: AiModel[];
		source: "remote" | "catalog";
		error?: string;
	}> {
		let prepared: PreparedRequest | undefined;
		try {
			prepared = await this.request(accountId, signal);
			const payload = object(await prepared.response.json());
			const candidates = payload.models ?? payload.data;
			const requireListed =
				prepared.credential.authMode === "siwc" &&
				Array.isArray(payload.models);
			const models = Array.isArray(candidates)
				? candidates.slice(0, 1000).flatMap((candidate: unknown): AiModel[] => {
						const item = object(candidate);
						const id = item.slug ?? item.id;
						if (
							typeof id !== "string" ||
							!modelSchema.safeParse(id).success ||
							item.visibility === "hidden" ||
							item.visibility === "hide" ||
							(requireListed && item.visibility !== "list")
						) {
							return [];
						}
						return [
							{
								id,
								name:
									typeof item.display_name === "string"
										? item.display_name.slice(0, 200)
										: id,
							},
						];
					})
				: [];
			if (models.length === 0) {
				throw new AiError("Провайдер не вернул доступные модели.", 502);
			}
			return {
				models: [...new Map(models.map((model) => [model.id, model])).values()],
				source: "remote",
			};
		} catch (error) {
			if (signal?.aborted) {
				// biome-ignore lint/style/useErrorCause: cancellation is sanitized without provider data in its cause.
				throw new AiError("AI-запрос отменён.", 499);
			}
			const credential =
				prepared?.credential ?? (await this.credential(accountId));
			const catalog =
				AI_PROVIDERS.find((provider) => provider.id === credential.provider)
					?.models ?? [];
			return {
				error: safeAiError(error).error,
				models: catalog.map((model) => ({ ...model })),
				source: "catalog",
			};
		} finally {
			prepared?.context.close();
		}
	}

	async chat(input: AiChatRequest, signal: AbortSignal): Promise<Response> {
		const parsed = validate(chatSchema, input);
		const prepared = await this.request(
			parsed.accountId,
			signal,
			(credential) => chatBody(parsed, credential)
		);
		return streamResponse(
			prepared,
			async function* () {
				for await (const event of normalizedEvents(prepared)) {
					yield `${JSON.stringify(event)}\n`;
				}
			},
			"application/x-ndjson; charset=utf-8",
			(error) => `${JSON.stringify({ error, type: "error" })}\n`
		);
	}

	async gateway(
		path: "/v1/chat/completions" | "/v1/responses" | "/v1/messages",
		body: unknown,
		accountId: string,
		signal: AbortSignal
	): Promise<Response> {
		if (path === "/v1/chat/completions") {
			return await this.completions(body, accountId, signal);
		}
		if (path !== "/v1/responses" && path !== "/v1/messages") {
			throw new AiError("Неподдерживаемый AI-метод.", 404);
		}
		const parsed =
			path === "/v1/responses"
				? validate(responsesSchema, body)
				: validate(anthropicSchema, body);
		boundedNativeBody(parsed);
		const credential = await this.credential(accountId);
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
				if (
					!payload ||
					typeof payload !== "object" ||
					Array.isArray(payload) ||
					object(payload).error
				) {
					throw new AiError("Провайдер вернул некорректный AI-ответ.", 502);
				}
				return Response.json(payload, {
					headers: { "Cache-Control": "no-store" },
				});
			} catch (error) {
				throw transportError(error, prepared.context);
			} finally {
				prepared.context.close();
			}
		}
		if (!wantsStream) {
			return await this.collectNativeResponses(prepared);
		}
		return streamResponse(
			prepared,
			async function* () {
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
					yield sse(event, frame.event);
					if (
						type ===
						(prepared.credential.provider === "claude"
							? "message_stop"
							: "response.completed")
					) {
						return;
					}
				}
				throw new AiError(
					"Соединение с провайдером оборвалось до завершения AI-ответа.",
					502
				);
			},
			"text/event-stream; charset=utf-8",
			(error) =>
				sse(
					{ error: { message: error, type: "api_error" }, type: "error" },
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
			throw transportError(error, prepared.context);
		} finally {
			prepared.context.close();
		}
	}

	private async completions(
		body: unknown,
		accountId: string,
		signal: AbortSignal
	): Promise<Response> {
		const parsed = validate(completionSchema, body);
		const input: AiChatRequest = {
			accountId,
			maxTokens: parsed.max_completion_tokens ?? parsed.max_tokens,
			messages: parsed.messages,
			model: parsed.model,
		};
		const options = {
			...(parsed.temperature === undefined
				? {}
				: { temperature: parsed.temperature }),
			...(parsed.top_p === undefined ? {} : { top_p: parsed.top_p }),
		};
		const prepared = await this.request(accountId, signal, (credential) =>
			chatBody(input, credential, options)
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
			return streamResponse(
				prepared,
				async function* () {
					yield sse(chunk({ role: "assistant" }));
					for await (const event of normalizedEvents(prepared)) {
						if (event.type === "text") {
							yield sse(chunk({ content: event.text }));
						} else if (event.type === "done") {
							yield sse(chunk({}, "stop"));
							if (parsed.stream_options?.include_usage && event.usage) {
								yield sse({
									...chunk({}),
									choices: [],
									usage: {
										completion_tokens: event.usage.outputTokens,
										prompt_tokens: event.usage.inputTokens,
										total_tokens:
											event.usage.inputTokens + event.usage.outputTokens,
									},
								});
							}
							yield "data: [DONE]\n\n";
						}
					}
				},
				"text/event-stream; charset=utf-8",
				(error) =>
					sse({
						error: {
							code: "provider_error",
							message: error,
							type: "api_error",
						},
					})
			);
		}
		try {
			let text = "";
			let tokenUsage = { inputTokens: 0, outputTokens: 0 };
			for await (const event of normalizedEvents(prepared)) {
				if (event.type === "text") {
					text += event.text;
					if (text.length > 4_194_304) {
						throw new AiError("AI-ответ превышает допустимый размер.", 502);
					}
				} else if (event.type === "done" && event.usage) {
					tokenUsage = event.usage;
				}
			}
			return Response.json(
				{
					choices: [
						{
							finish_reason: "stop",
							index: 0,
							message: { content: text, role: "assistant" },
						},
					],
					created,
					id,
					model: parsed.model,
					object: "chat.completion",
					usage: {
						completion_tokens: tokenUsage.outputTokens,
						prompt_tokens: tokenUsage.inputTokens,
						total_tokens: tokenUsage.inputTokens + tokenUsage.outputTokens,
					},
				},
				{ headers: { "Cache-Control": "no-store" } }
			);
		} catch (error) {
			throw transportError(error, prepared.context);
		} finally {
			prepared.context.close();
		}
	}
}
