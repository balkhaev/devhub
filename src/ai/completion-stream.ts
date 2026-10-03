import { AiError } from "./types";

export interface CompletionUsage {
	completion_tokens: number;
	completion_tokens_details?: { reasoning_tokens: number };
	prompt_tokens: number;
	prompt_tokens_details?: {
		cached_tokens: number;
		cache_creation_tokens?: number;
	};
	total_tokens: number;
}
export interface CompletionEvent {
	delta?: Record<string, unknown>;
	done?: boolean;
	finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
	usage?: CompletionUsage;
}
interface ToolCall {
	arguments: string;
	id: string;
	index: number;
	name: string;
}
export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}
function invalid(): never {
	throw new AiError("Провайдер вернул некорректный вызов инструмента.", 502);
}

export function validateResponseEnvelope(
	value: unknown,
	expectedStatus = "completed"
): Record<string, unknown> {
	const response = record(value);
	if (
		typeof response.id !== "string" ||
		response.id.length === 0 ||
		!Array.isArray(response.output) ||
		(response.status !== undefined && response.status !== expectedStatus)
	) {
		throw new AiError(
			"Провайдер вернул некорректное завершение AI-ответа.",
			502
		);
	}
	return response;
}

/** Protocol state is per response. Tool indices are independent of native text/reasoning block indices. */
export class CompletionDecoder {
	private readonly tools = new Map<string, ToolCall>();
	private readonly blocks = new Map<number, string>();
	private text = "";
	private refusal = "";
	private nativeUsage: Record<string, unknown> = {};
	private stopReason = "end_turn";
	private readonly claude: boolean;

	constructor(claude: boolean) {
		this.claude = claude;
	}

	private startTool(
		key: string,
		value: Record<string, unknown>
	): CompletionEvent[] {
		const id = value.call_id ?? value.id;
		if (
			typeof id !== "string" ||
			!id ||
			typeof value.name !== "string" ||
			!value.name
		) {
			invalid();
		}
		const existing =
			this.tools.get(key) ??
			[...this.tools.values()].find((candidate) => candidate.id === id);
		if (existing) {
			if (existing.id !== id || existing.name !== value.name) {
				invalid();
			}
			this.tools.set(key, existing);
			return [];
		}
		const tool: ToolCall = {
			arguments: "",
			id,
			index: new Set(this.tools.values()).size,
			name: value.name,
		};
		this.tools.set(key, tool);
		return [
			{
				delta: {
					tool_calls: [
						{
							function: { arguments: "", name: tool.name },
							id,
							index: tool.index,
							type: "function",
						},
					],
				},
			},
		];
	}

	private appendArguments(key: string, value: string): CompletionEvent[] {
		const tool = this.tools.get(key);
		if (!tool) {
			return invalid();
		}
		tool.arguments += value;
		if (tool.arguments.length > 4_194_304) {
			throw new AiError("AI-ответ превышает допустимый размер.", 502);
		}
		return value
			? [
					{
						delta: {
							tool_calls: [
								{ function: { arguments: value }, index: tool.index },
							],
						},
					},
				]
			: [];
	}

	private finalArguments(key: string, value: unknown): CompletionEvent[] {
		if (typeof value !== "string") {
			return invalid();
		}
		const tool = this.tools.get(key);
		if (!(tool && value.startsWith(tool.arguments))) {
			return invalid();
		}
		return this.appendArguments(key, value.slice(tool.arguments.length));
	}

	private usage(): CompletionUsage {
		const input = count(this.nativeUsage.input_tokens);
		const output = count(this.nativeUsage.output_tokens);
		const cached = this.claude
			? count(this.nativeUsage.cache_read_input_tokens)
			: count(record(this.nativeUsage.input_tokens_details).cached_tokens);
		const creation = this.claude
			? count(this.nativeUsage.cache_creation_input_tokens)
			: 0;
		const prompt = input + (this.claude ? cached + creation : 0);
		const reasoning = count(
			record(this.nativeUsage.output_tokens_details).reasoning_tokens
		);
		return {
			completion_tokens: output,
			prompt_tokens: prompt,
			total_tokens: prompt + output,
			...(cached || creation
				? {
						prompt_tokens_details: {
							cached_tokens: cached,
							...(creation ? { cache_creation_tokens: creation } : {}),
						},
					}
				: {}),
			...(reasoning
				? { completion_tokens_details: { reasoning_tokens: reasoning } }
				: {}),
		};
	}

	private terminal(reason?: CompletionEvent["finishReason"]): CompletionEvent {
		let finishReason = reason ?? "stop";
		if (!reason && this.refusal.length > 0) {
			finishReason = "content_filter";
		}
		if (!reason && this.tools.size > 0) {
			finishReason = "tool_calls";
		}
		return {
			done: true,
			finishReason,
			usage: this.usage(),
		};
	}

	feed(type: string, event: Record<string, unknown>): CompletionEvent[] {
		return this.claude
			? this.fromClaude(type, event)
			: this.fromResponses(type, event);
	}

	private fromResponses(
		type: string,
		event: Record<string, unknown>
	): CompletionEvent[] {
		const key = `output:${event.output_index}`;
		switch (type) {
			case "response.output_text.delta":
				return this.textDelta(event.delta);
			case "response.refusal.delta":
				return this.refusalDelta(event.delta);
			case "response.output_item.added":
			case "response.output_item.done":
				return this.responseToolItem(key, record(event.item));
			case "response.function_call_arguments.delta":
				return typeof event.delta === "string"
					? this.appendArguments(key, event.delta)
					: invalid();
			case "response.function_call_arguments.done":
				return this.finalArguments(key, event.arguments);
			case "response.completed":
			case "response.incomplete":
				return this.responseTerminal(
					record(event.response),
					type === "response.incomplete"
				);
			default:
				return [];
		}
	}

	private textDelta(value: unknown): CompletionEvent[] {
		if (typeof value !== "string") {
			return invalid();
		}
		this.text += value;
		return [{ delta: { content: value } }];
	}
	private refusalDelta(value: unknown): CompletionEvent[] {
		if (typeof value !== "string") {
			return invalid();
		}
		this.refusal += value;
		return [{ delta: { refusal: value } }];
	}
	private responseToolItem(
		key: string,
		item: Record<string, unknown>
	): CompletionEvent[] {
		if (item.type !== "function_call") {
			return [];
		}
		const result = this.startTool(key, item);
		if (typeof item.arguments === "string" && item.arguments.length > 0) {
			result.push(...this.finalArguments(key, item.arguments));
		}
		return result;
	}
	private responseTerminal(
		response: Record<string, unknown>,
		limited: boolean
	): CompletionEvent[] {
		validateResponseEnvelope(response, limited ? "incomplete" : "completed");
		this.nativeUsage = record(response.usage);
		const result: CompletionEvent[] = [];
		let terminalText = "";
		let terminalRefusal = "";
		for (const [index, raw] of (Array.isArray(response.output)
			? response.output
			: []
		).entries()) {
			const item = record(raw);
			if (item.type === "function_call") {
				const key = `output:${index}`;
				result.push(
					...this.startTool(key, item),
					...this.finalArguments(key, item.arguments)
				);
			} else if (item.type === "message") {
				const contents = responseText(item.content);
				terminalText += contents.text;
				terminalRefusal += contents.refusal;
			}
		}
		if (this.text.length === 0 && terminalText.length > 0) {
			result.push(...this.textDelta(terminalText));
		}
		if (this.refusal.length === 0 && terminalRefusal.length > 0) {
			result.push(...this.refusalDelta(terminalRefusal));
		}
		result.push(this.terminal(limited ? "length" : undefined));
		return result;
	}

	private fromClaude(
		type: string,
		event: Record<string, unknown>
	): CompletionEvent[] {
		switch (type) {
			case "message_start":
				this.nativeUsage = record(record(event.message).usage);
				return [];
			case "content_block_start":
				return this.claudeBlockStart(event);
			case "content_block_delta":
				return this.claudeBlockDelta(event);
			case "content_block_stop":
				return this.claudeBlockStop(event);
			case "message_delta": {
				this.nativeUsage = { ...this.nativeUsage, ...record(event.usage) };
				const stop = record(event.delta).stop_reason;
				if (typeof stop === "string") {
					this.stopReason = stop;
				}
				return [];
			}
			case "message_stop":
				return [this.terminal(claudeStopReason(this.stopReason))];
			default:
				return [];
		}
	}

	private claudeBlockStart(event: Record<string, unknown>): CompletionEvent[] {
		const block = record(event.content_block);
		if (block.type === "tool_use") {
			if (typeof event.index !== "number") {
				return invalid();
			}
			const key = `block:${event.index}`;
			this.blocks.set(event.index, key);
			const result = this.startTool(key, block);
			const input = record(block.input);
			if (Object.keys(input).length) {
				result.push(...this.appendArguments(key, JSON.stringify(input)));
			}
			return result;
		}
		if (
			block.type === "text" &&
			typeof block.text === "string" &&
			block.text.length > 0
		) {
			return this.textDelta(block.text);
		}
		return [];
	}
	private claudeBlockDelta(event: Record<string, unknown>): CompletionEvent[] {
		const delta = record(event.delta);
		if (delta.type === "text_delta" && typeof delta.text === "string") {
			return this.textDelta(delta.text);
		}
		if (
			delta.type === "input_json_delta" &&
			typeof delta.partial_json === "string"
		) {
			const key =
				typeof event.index === "number"
					? this.blocks.get(event.index)
					: undefined;
			if (!key) {
				return invalid();
			}
			return this.appendArguments(key, delta.partial_json);
		}
		return [];
	}
	private claudeBlockStop(event: Record<string, unknown>): CompletionEvent[] {
		if (typeof event.index === "number") {
			const key = this.blocks.get(event.index);
			if (key && this.tools.get(key)?.arguments === "") {
				return this.appendArguments(key, "{}");
			}
		}
		return [];
	}
}

function responseText(value: unknown): { text: string; refusal: string } {
	let text = "";
	let refusal = "";
	for (const raw of Array.isArray(value) ? value : []) {
		const part = record(raw);
		if (part.type === "output_text" && typeof part.text === "string") {
			text += part.text;
		}
		if (part.type === "refusal" && typeof part.refusal === "string") {
			refusal += part.refusal;
		}
	}
	return { refusal, text };
}
function claudeStopReason(value: string): CompletionEvent["finishReason"] {
	switch (value) {
		case "max_tokens":
			return "length";
		case "refusal":
			return "content_filter";
		case "tool_use":
			return "tool_calls";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			throw new AiError(
				"Claude завершил ответ с неподдерживаемой причиной. Используйте native /v1/messages.",
				502
			);
	}
}

export class CompletionCollector {
	private readonly tools = new Map<number, Record<string, unknown>>();
	private text = "";
	private refusal = "";
	finishReason: CompletionEvent["finishReason"] = "stop";
	usage: CompletionUsage = {
		completion_tokens: 0,
		prompt_tokens: 0,
		total_tokens: 0,
	};
	private size = 0;

	accept(event: CompletionEvent): void {
		this.size += JSON.stringify(event).length;
		if (this.size > 4_194_304) {
			throw new AiError("AI-ответ превышает допустимый размер.", 502);
		}
		const { delta } = event;
		if (typeof delta?.content === "string") {
			this.text += delta.content;
		}
		if (typeof delta?.refusal === "string") {
			this.refusal += delta.refusal;
		}
		for (const value of Array.isArray(delta?.tool_calls)
			? delta.tool_calls
			: []) {
			const raw = record(value);
			const { index } = raw;
			if (typeof index !== "number") {
				invalid();
			}
			const tool = this.tools.get(index) ?? {
				function: { arguments: "", name: record(raw.function).name },
				id: raw.id,
				type: "function",
			};
			const fn = record(tool.function);
			const part = record(raw.function);
			if (typeof part.arguments === "string") {
				fn.arguments = String(fn.arguments ?? "") + part.arguments;
			}
			tool.function = fn;
			this.tools.set(index, tool);
		}
		if (event.done) {
			this.finishReason = event.finishReason;
			this.usage = event.usage ?? this.usage;
		}
	}

	message(): Record<string, unknown> {
		let content: string | null = this.text;
		if (
			this.text.length === 0 &&
			(this.tools.size > 0 || this.refusal.length > 0)
		) {
			content = null;
		}
		return {
			content,
			role: "assistant",
			...(this.refusal.length > 0 ? { refusal: this.refusal } : {}),
			...(this.tools.size
				? {
						tool_calls: [...this.tools.entries()]
							.sort(([a], [b]) => a - b)
							.map(([, tool]) => tool),
					}
				: {}),
		};
	}
}
