import { AiError } from "./types";

export interface SseFrame {
	data: string;
	event?: string;
}
const LINE_END = /[\r\n]/;
const FRAME_LIMIT = 1_048_576;

class SseDecoder {
	private buffer = "";
	private event?: string;
	private data: string[] = [];
	private frameSize = 0;

	*push(text: string, ended: boolean): Generator<SseFrame> {
		this.buffer += text;
		if (this.buffer.length + this.frameSize > FRAME_LIMIT) {
			throw new AiError(
				"Провайдер вернул слишком большой фрагмент ответа.",
				502
			);
		}
		let line = this.takeLine(ended);
		while (line !== undefined) {
			const frame = this.accept(line);
			if (frame) {
				yield frame;
			}
			line = this.takeLine(ended);
		}
		// An EOF without the empty separator line is a truncated SSE frame.
	}

	private takeLine(ended: boolean): string | undefined {
		if (this.buffer.length === 0) {
			return;
		}
		const match = LINE_END.exec(this.buffer);
		if (!(match || ended)) {
			return;
		}
		const position = match?.index ?? this.buffer.length;
		if (
			!ended &&
			this.buffer[position] === "\r" &&
			position === this.buffer.length - 1
		) {
			return;
		}
		const line = this.buffer.slice(0, position);
		const separator =
			this.buffer.slice(position, position + 2) === "\r\n" ? 2 : 1;
		this.buffer = this.buffer.slice(position + separator);
		return line;
	}

	private accept(line: string): SseFrame | undefined {
		if (line === "") {
			return this.flush();
		}
		if (line.startsWith(":")) {
			return;
		}
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		const rawValue = colon < 0 ? "" : line.slice(colon + 1);
		const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
		if (field === "event") {
			this.event = value;
		}
		if (field === "data") {
			this.data.push(value);
			this.frameSize += value.length;
		}
	}

	private flush(): SseFrame | undefined {
		const frame =
			this.data.length > 0
				? { data: this.data.join("\n"), event: this.event }
				: undefined;
		this.event = undefined;
		this.data = [];
		this.frameSize = 0;
		return frame;
	}
}

/** Decode incrementally: UTF-8 code points, CRLFs and SSE frames can cross packets. */
export async function* readSse(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal
): AsyncGenerator<SseFrame> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const parser = new SseDecoder();
	const cancel = () => {
		reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		let ended = false;
		while (!ended) {
			signal.throwIfAborted();
			// biome-ignore lint/performance/noAwaitInLoops: packets from one stream must be decoded in order.
			const packet = await reader.read();
			signal.throwIfAborted();
			ended = packet.done;
			yield* parser.push(
				decoder.decode(packet.value, { stream: !ended }),
				ended
			);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export function parseSseJson(
	frame: SseFrame
): Record<string, unknown> | undefined {
	if (frame.data === "[DONE]") {
		return;
	}
	try {
		const value: unknown = JSON.parse(frame.data);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		/* Provider data is deliberately excluded from error messages. */
	}
	throw new AiError("Провайдер вернул повреждённый поток ответа.", 502);
}
