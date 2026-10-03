import { z } from "zod";
import { type AiCredential, AiError } from "./types";

const IMAGE_URL = /^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/;
const PDF_DATA = /^data:application\/pdf;base64,(.+)$/s;
const IMAGE_DATA = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s;

const text = z.string().max(262_144);
const name = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/);
const textPart = z.object({ text, type: z.literal("text") }).strict();
const imagePart = z
	.object({
		image_url: z
			.object({
				detail: z.enum(["auto", "low", "high", "original"]).optional(),
				url: z
					.string()
					.min(1)
					.max(1_048_576)
					.refine((value) => IMAGE_URL.test(value)),
			})
			.strict(),
		type: z.literal("image_url"),
	})
	.strict();
const filePart = z
	.object({
		file: z
			.object({
				file_data: z.string().min(1).max(1_048_576),
				filename: z.string().min(1).max(256),
			})
			.strict(),
		type: z.literal("file"),
	})
	.strict();
const richContent = z.union([
	text,
	z
		.array(z.union([textPart, imagePart, filePart]))
		.min(1)
		.max(100),
]);
const textContent = z.union([text, z.array(textPart).min(1).max(100)]);
const definition = z
	.object({
		description: text.optional(),
		name,
		parameters: z.record(z.string(), z.unknown()).optional(),
		strict: z.boolean().optional(),
	})
	.strict();
const callSchema = z
	.object({
		function: z.object({ arguments: text, name }).strict(),
		id: z.string().min(1).max(200),
		type: z.literal("function"),
	})
	.strict();
const messageSchema = z.discriminatedUnion("role", [
	z
		.object({ content: textContent, role: z.enum(["system", "developer"]) })
		.strict(),
	z.object({ content: richContent, role: z.literal("user") }).strict(),
	z
		.object({
			content: textContent.nullable().optional(),
			refusal: text.nullable().optional(),
			role: z.literal("assistant"),
			tool_calls: z.array(callSchema).min(1).max(100).optional(),
		})
		.strict()
		.refine(
			(value) =>
				(value.content !== null && value.content !== undefined) ||
				value.tool_calls ||
				(value.refusal !== null && value.refusal !== undefined)
		),
	z
		.object({
			content: richContent,
			role: z.literal("tool"),
			tool_call_id: z.string().min(1).max(200),
		})
		.strict(),
]);
export const completionSchema = z
	.object({
		max_completion_tokens: z.number().int().min(1).max(131_072).optional(),
		max_tokens: z.number().int().min(1).max(131_072).optional(),
		messages: z.array(messageSchema).min(1).max(100),
		model: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
		parallel_tool_calls: z.boolean().optional(),
		reasoning_effort: z
			.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
			.optional(),
		response_format: z
			.union([
				z.object({ type: z.enum(["text", "json_object"]) }).strict(),
				z
					.object({
						json_schema: z
							.object({
								description: text.optional(),
								name,
								schema: z.record(z.string(), z.unknown()),
								strict: z.boolean().optional(),
							})
							.strict(),
						type: z.literal("json_schema"),
					})
					.strict(),
			])
			.optional(),
		stop: z
			.union([z.string().max(200), z.array(z.string().max(200)).min(1).max(4)])
			.optional(),
		stream: z.boolean().optional(),
		stream_options: z
			.object({ include_usage: z.boolean().optional() })
			.strict()
			.optional(),
		temperature: z.number().min(0).max(2).optional(),
		tool_choice: z
			.union([
				z.enum(["auto", "none", "required"]),
				z
					.object({
						function: z.object({ name }).strict(),
						type: z.literal("function"),
					})
					.strict(),
			])
			.optional(),
		tools: z
			.array(
				z.object({ function: definition, type: z.literal("function") }).strict()
			)
			.max(100)
			.optional(),
		top_p: z.number().min(0).max(1).optional(),
	})
	.strict();
export type CompletionRequest = z.infer<typeof completionSchema>;
type Part =
	| z.infer<typeof textPart>
	| z.infer<typeof imagePart>
	| z.infer<typeof filePart>;

function invalid(message: string): never {
	throw new AiError(message, 400);
}

export function boundedRequest(value: unknown): void {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576) {
		throw new AiError("AI-запрос превышает допустимый размер 1 МБ.", 413);
	}
}

function parts(value: string | Part[] | null | undefined): Part[] {
	return typeof value === "string"
		? [{ text: value, type: "text" }]
		: (value ?? []);
}

function openAiParts(
	value: string | Part[] | null | undefined,
	assistant = false
): Record<string, unknown>[] {
	return parts(value).map((part) => {
		if (part.type === "text") {
			return {
				text: part.text,
				type: assistant ? "output_text" : "input_text",
			};
		}
		if (part.type === "file") {
			return { type: "input_file", ...part.file };
		}
		return {
			image_url: part.image_url.url,
			type: "input_image",
			...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
		};
	});
}

function claudeParts(
	value: string | Part[] | null | undefined
): Record<string, unknown>[] {
	return parts(value).flatMap((part): Record<string, unknown>[] => {
		if (part.type === "text") {
			return part.text ? [{ text: part.text, type: "text" }] : [];
		}
		if (part.type === "file") {
			const match = PDF_DATA.exec(part.file.file_data);
			if (!match) {
				return invalid(
					"Для Claude файл в совместимом API должен быть PDF в data URL."
				);
			}
			return [
				{
					source: {
						data: match[1],
						media_type: "application/pdf",
						type: "base64",
					},
					title: part.file.filename,
					type: "document",
				},
			];
		}
		if (part.image_url.detail && part.image_url.detail !== "auto") {
			invalid(
				"Claude не поддерживает параметр image_url.detail. Удалите его или выберите auto."
			);
		}
		const match = IMAGE_DATA.exec(part.image_url.url);
		return [
			{
				source: match
					? { data: match[2], media_type: match[1], type: "base64" }
					: { type: "url", url: part.image_url.url },
				type: "image",
			},
		];
	});
}

function argumentsObject(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* Arguments are caller data; do not expose them in errors. */
	}
	return invalid("Аргументы вызова инструмента должны содержать JSON-объект.");
}

/** Preserve call identities and enforce adjacent, complete tool-result groups before any upstream call. */
function validateHistory(input: CompletionRequest): void {
	const pending = new Set<string>();
	const seen = new Set<string>();
	for (const message of input.messages) {
		if (message.role === "tool") {
			if (!pending.delete(message.tool_call_id)) {
				invalid("Результат инструмента не соответствует ожидаемому вызову.");
			}
			continue;
		}
		if (pending.size) {
			invalid(
				"Сразу после вызовов инструментов нужны результаты всех вызовов."
			);
		}
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				if (seen.has(call.id)) {
					invalid(
						"Идентификаторы вызовов инструментов должны быть уникальными."
					);
				}
				argumentsObject(call.function.arguments);
				seen.add(call.id);
				pending.add(call.id);
			}
		}
	}
	if (pending.size) {
		invalid("В истории отсутствуют результаты вызовов инструментов.");
	}
	validateTools(input);
}

function validateTools(input: CompletionRequest): void {
	const names = new Set<string>();
	for (const tool of input.tools ?? []) {
		if (names.has(tool.function.name)) {
			invalid("Имена инструментов должны быть уникальными.");
		}
		names.add(tool.function.name);
	}
	if (
		typeof input.tool_choice === "object" &&
		!names.has(input.tool_choice.function.name)
	) {
		invalid("Выбранный инструмент отсутствует в tools.");
	}
	if (
		(input.tool_choice === "required" ||
			typeof input.tool_choice === "object") &&
		!names.size
	) {
		invalid("tool_choice требует определения tools.");
	}
}

export function completionBody(
	input: CompletionRequest,
	credential: AiCredential
): Record<string, unknown> {
	boundedRequest(input);
	validateHistory(input);
	if (credential.provider === "claude") {
		return toClaude(input);
	}
	for (const field of [
		"max_tokens",
		"max_completion_tokens",
		"temperature",
		"top_p",
		"stop",
	] as const) {
		if (input[field] !== undefined) {
			invalid(
				`Подписка OpenAI не поддерживает ${field}. Удалите этот параметр.`
			);
		}
	}
	const history = responsesHistory(
		input,
		credential.authMode === "siwc" ? "devhub" : undefined
	);
	const tools = input.tools?.map((tool) => ({
		type: "function",
		...tool.function,
	}));
	const choice =
		typeof input.tool_choice === "object"
			? { name: input.tool_choice.function.name, type: "function" }
			: input.tool_choice;
	const result: Record<string, unknown> = {
		input: history,
		model: input.model,
		store: false,
		stream: true,
	};
	if (credential.authMode === "codex") {
		result.instructions = "";
	}
	if (tools) {
		result.tools =
			credential.authMode === "siwc" && tools.length
				? [{ name: "devhub", tools, type: "namespace" }]
				: tools;
	}
	if (choice !== undefined) {
		result.tool_choice = choice;
	}
	if (input.parallel_tool_calls !== undefined) {
		result.parallel_tool_calls = input.parallel_tool_calls;
	}
	if (input.reasoning_effort) {
		result.reasoning = { effort: input.reasoning_effort };
	}
	if (input.response_format) {
		const format =
			input.response_format.type === "json_schema"
				? { type: "json_schema", ...input.response_format.json_schema }
				: input.response_format;
		result.text = { format };
	}
	return result;
}

function responsesHistory(
	input: CompletionRequest,
	namespace?: string
): Record<string, unknown>[] {
	const history: Record<string, unknown>[] = [];
	for (const message of input.messages) {
		if (message.role === "tool") {
			history.push({
				call_id: message.tool_call_id,
				output:
					typeof message.content === "string"
						? message.content
						: openAiParts(message.content),
				type: "function_call_output",
			});
			continue;
		}
		const content = openAiParts(message.content, message.role === "assistant");
		if (message.role === "assistant" && message.refusal) {
			content.push({ refusal: message.refusal, type: "refusal" });
		}
		if (content.length) {
			history.push({
				content,
				role: message.role === "system" ? "developer" : message.role,
			});
		}
		if (message.role === "assistant") {
			history.push(...responsesCalls(message.tool_calls ?? [], namespace));
		}
	}
	return history;
}

function responsesCalls(
	calls: z.infer<typeof callSchema>[],
	namespace?: string
): Record<string, unknown>[] {
	return calls.map((call) => ({
		arguments: call.function.arguments,
		call_id: call.id,
		name: call.function.name,
		...(namespace ? { namespace } : {}),
		type: "function_call",
	}));
}

function toClaude(input: CompletionRequest): Record<string, unknown> {
	if (input.reasoning_effort !== undefined) {
		invalid(
			"Для настройки мышления Claude используйте native /v1/messages с thinking/output_config."
		);
	}
	if (input.response_format && input.response_format.type !== "text") {
		invalid(
			"Для структурированного вывода Claude используйте native /v1/messages с output_config."
		);
	}
	if (input.temperature !== undefined && input.temperature > 1) {
		invalid("Claude принимает temperature от 0 до 1.");
	}
	const { system, messages } = claudeHistory(input);
	const result: Record<string, unknown> = {
		max_tokens: input.max_completion_tokens ?? input.max_tokens ?? 4096,
		messages,
		model: input.model,
		stream: true,
	};
	if (system.length) {
		result.system = system.join("\n\n");
	}
	if (input.tools) {
		result.tools = input.tools.map((tool) => claudeTool(tool.function));
		result.tool_choice = {
			...claudeChoice(input.tool_choice),
			...(input.parallel_tool_calls === false
				? { disable_parallel_tool_use: true }
				: {}),
		};
	}
	if (input.temperature !== undefined) {
		result.temperature = input.temperature;
	}
	if (input.top_p !== undefined) {
		result.top_p = input.top_p;
	}
	if (input.stop !== undefined) {
		result.stop_sequences =
			typeof input.stop === "string" ? [input.stop] : input.stop;
	}
	return result;
}

function claudeTool(tool: z.infer<typeof definition>): Record<string, unknown> {
	return {
		input_schema: tool.parameters ?? { properties: {}, type: "object" },
		name: tool.name,
		...(tool.description === undefined
			? {}
			: { description: tool.description }),
		...(tool.strict === undefined ? {} : { strict: tool.strict }),
	};
}
function claudeChoice(
	value: CompletionRequest["tool_choice"]
): Record<string, unknown> {
	if (value === "required") {
		return { type: "any" };
	}
	if (typeof value === "object") {
		return { name: value.function.name, type: "tool" };
	}
	return { type: value ?? "auto" };
}
type Message = CompletionRequest["messages"][number];
function claudeMessageContent(
	message: Exclude<Message, { role: "system" | "developer" }>
): Record<string, unknown>[] {
	if (message.role === "tool") {
		return [
			{
				content:
					typeof message.content === "string"
						? message.content
						: claudeParts(message.content),
				tool_use_id: message.tool_call_id,
				type: "tool_result",
			},
		];
	}
	const content = claudeParts(message.content);
	if (message.role === "assistant") {
		if (message.refusal) {
			content.push({ text: message.refusal, type: "text" });
		}
		for (const call of message.tool_calls ?? []) {
			content.push({
				id: call.id,
				input: argumentsObject(call.function.arguments),
				name: call.function.name,
				type: "tool_use",
			});
		}
	}
	return content;
}

function claudeHistory(input: CompletionRequest): {
	system: string[];
	messages: {
		role: "user" | "assistant";
		content: Record<string, unknown>[];
	}[];
} {
	const system: string[] = [];
	const messages: {
		role: "user" | "assistant";
		content: Record<string, unknown>[];
	}[] = [];
	for (const message of input.messages) {
		if (message.role === "system" || message.role === "developer") {
			system.push(
				parts(message.content)
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("\n")
			);
			continue;
		}
		const role = message.role === "assistant" ? "assistant" : "user";
		const content = claudeMessageContent(
			message as Exclude<Message, { role: "system" | "developer" }>
		);
		if (!content.length) {
			invalid("Claude требует непустое содержимое сообщения.");
		}
		const previous = messages.at(-1);
		if (previous?.role === role) {
			previous.content.push(...content);
		} else {
			messages.push({ content, role });
		}
	}
	if (!messages.length) {
		invalid("Claude требует сообщение пользователя или ассистента.");
	}
	return { messages, system };
}
