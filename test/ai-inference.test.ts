function responseReader(
	response: Response
): ReadableStreamDefaultReader<Uint8Array> {
	if (!response.body) {
		throw new Error("expected response body");
	}
	return response.body.getReader();
}

import { describe, expect, test } from "bun:test";
import { AiInference } from "../src/ai/inference";
import { type AiCredential, AiError } from "../src/ai/types";

const base: AiCredential = {
	accessToken: "private-token",
	accountId: "workspace-1",
	authMode: "codex",
	clientId: "test-client",
	id: "account-1",
	label: "test",
	provider: "codex",
	source: "oauth",
};
const input = {
	accountId: base.id,
	messages: [{ content: "Привет", role: "user" as const }],
	model: "gpt-test",
};
const encode = new TextEncoder();
function frame(value: unknown, event?: string): string {
	return `${event ? `event: ${event}\r\n` : ""}data: ${JSON.stringify(value)}\r\n\r\n`;
}
function completed(text = "Привет"): string {
	return (
		frame({ delta: text, type: "response.output_text.delta" }) +
		frame({
			response: {
				id: "resp-test",
				object: "response",
				output: [{ content: [{ text, type: "output_text" }], type: "message" }],
				usage: { input_tokens: 10, output_tokens: 4 },
			},
			type: "response.completed",
		})
	);
}
function packets(text: string, width = 1): Response {
	const bytes = encode.encode(text);
	let position = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (position === bytes.length) {
					controller.close();
					return;
				}
				controller.enqueue(bytes.slice(position, position + width));
				position = Math.min(bytes.length, position + width);
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } }
	);
}
function adapter(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
	credential: AiCredential = base
): AiInference {
	return new AiInference({
		credential: async () => credential,
		fetch: ((url: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch,
	});
}
async function events(response: Response): Promise<unknown[]> {
	return (await response.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}
const signal = () => new AbortController().signal;

describe("subscription inference", () => {
	test("Codex transforms chat and decodes split UTF-8 / CRLF / terminal usage", async () => {
		const ai = adapter((url, init) => {
			expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
			const headers = new Headers(init.headers);
			expect(headers.get("Authorization")).toBe("Bearer private-token");
			expect(headers.get("chatgpt-account-id")).toBe("workspace-1");
			expect(init.redirect).toBe("error");
			expect(init.signal).toBeInstanceOf(AbortSignal);
			const body = JSON.parse(String(init.body));
			expect(body).toMatchObject({
				input: [
					{
						content: [{ text: "system", type: "input_text" }],
						role: "developer",
					},
					{ content: [{ text: "Привет", type: "input_text" }], role: "user" },
					{
						content: [{ text: "answer", type: "output_text" }],
						role: "assistant",
					},
				],
				instructions: "",
				store: false,
				stream: true,
			});
			expect(body.max_output_tokens).toBeUndefined();
			return packets(`: heartbeat\r\n\r\n${completed()}`);
		});
		const response = await ai.chat(
			{
				...input,
				maxTokens: 123,
				messages: [
					{ content: "system", role: "system" },
					...input.messages,
					{ content: "answer", role: "assistant" },
				],
			},
			signal()
		);
		expect(response.headers.get("Content-Type")).toContain("ndjson");
		expect(await events(response)).toEqual([
			{ text: "Привет", type: "text" },
			{ type: "done", usage: { inputTokens: 10, outputTokens: 4 } },
		]);
	});

	test("SIWC uses OpenAI API and retains output token limits", async () => {
		const ai = adapter(
			(url, init) => {
				expect(url).toBe("https://api.openai.com/v1/responses");
				expect(new Headers(init.headers).has("chatgpt-account-id")).toBe(false);
				expect(JSON.parse(String(init.body))).toMatchObject({
					max_output_tokens: 100,
					store: false,
					stream: true,
				});
				return packets(completed(), 31);
			},
			{ ...base, authMode: "siwc" }
		);
		expect(
			await events(await ai.chat({ ...input, maxTokens: 100 }, signal()))
		).toHaveLength(2);
	});

	test("Claude sends honest OAuth headers, separates system, and tracks terminal usage", async () => {
		const ai = adapter(
			(url, init) => {
				expect(url).toBe("https://api.anthropic.com/v1/messages");
				const headers = new Headers(init.headers);
				expect(headers.get("Authorization")).toBe("Bearer private-token");
				expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
				expect(headers.get("anthropic-version")).toBe("2023-06-01");
				expect(headers.get("User-Agent")).toBe("DevHub/0.1");
				expect(JSON.parse(String(init.body))).toEqual({
					max_tokens: 4096,
					messages: input.messages,
					model: "claude-test",
					stream: true,
					system: "rules",
				});
				return packets(
					frame({
						message: { usage: { input_tokens: 5 } },
						type: "message_start",
					}) +
						frame({
							delta: { text: "Да", type: "text_delta" },
							type: "content_block_delta",
						}) +
						frame({ type: "message_delta", usage: { output_tokens: 2 } }) +
						frame({ type: "message_stop" })
				);
			},
			{ ...base, authMode: "claude", provider: "claude" }
		);
		expect(
			await events(
				await ai.chat(
					{
						...input,
						messages: [{ content: "rules", role: "system" }, ...input.messages],
						model: "claude-test",
					},
					signal()
				)
			)
		).toEqual([
			{ text: "Да", type: "text" },
			{ type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
		]);
	});

	test("invalid messages/models never call upstream", async () => {
		let calls = 0;
		const ai = adapter(() => {
			calls += 1;
			return packets(completed());
		});
		for (const request of [
			{ ...input, model: "https://attacker.invalid" },
			{ ...input, messages: [] },
			{ ...input, messages: [{ content: "x".repeat(262_145), role: "user" }] },
		]) {
			// biome-ignore lint/performance/noAwaitInLoops: each fixture is checked before asserting the total fetch count.
			await expect(
				ai.chat(request as typeof input, signal())
			).rejects.toBeInstanceOf(AiError);
		}
		expect(calls).toBe(0);
	});

	test("401 refreshes once, 403/429 never retry or leak upstream details", async () => {
		const refreshes: boolean[] = [];
		let calls = 0;
		const ai = new AiInference({
			credential: (_id, force = false) => {
				refreshes.push(force);
				return Promise.resolve({
					...base,
					accessToken: force ? "new-token" : "old-token",
				});
			},
			fetch: (() => {
				calls += 1;
				return Promise.resolve(
					calls === 1
						? new Response("token secret", { status: 401 })
						: packets(completed())
				);
			}) as unknown as typeof fetch,
		});
		await (await ai.chat(input, signal())).text();
		expect(refreshes).toEqual([false, true]);
		expect(calls).toBe(2);
		for (const status of [403, 429]) {
			let deniedCalls = 0;
			const denied = adapter(
				() => {
					deniedCalls += 1;
					return new Response("private-token prompt secret", { status });
				},
				{ ...base, authMode: "claude", provider: "claude" }
			);
			try {
				// biome-ignore lint/performance/noAwaitInLoops: check each denied status before its next independent fixture.
				await denied.chat(input, signal());
				throw new Error("request should fail");
			} catch (error) {
				expect(error).toBeInstanceOf(AiError);
				expect((error as AiError).status).toBe(status);
				expect((error as Error).message).not.toContain("private-token");
				if (status === 403) {
					expect((error as Error).message).toContain("стороннего приложения");
				}
			}
			expect(deniedCalls).toBe(1);
		}
	});

	test("truncation, failed/incomplete events, and malformed JSON produce safe errors without done", async () => {
		const fixtures = [
			frame({ response: { usage: {} }, type: "response.completed" }).trimEnd(),
			frame({ delta: "partial", type: "response.output_text.delta" }) +
				"data: [DONE]\n\n",
			frame({
				response: { error: { message: "private-token" } },
				type: "response.failed",
			}),
			frame({ type: "response.incomplete" }),
			"data: broken secret\n\n",
		];
		for (const fixture of fixtures) {
			// biome-ignore lint/performance/noAwaitInLoops: malformed streams are checked in sequence.
			const result = await events(
				await adapter(() => packets(fixture)).chat(input, signal())
			);
			expect(
				result.some((event) => (event as { type: string }).type === "done")
			).toBe(false);
			expect((result.at(-1) as { type: string }).type).toBe("error");
			expect(JSON.stringify(result)).not.toContain("private-token");
			expect(JSON.stringify(result)).not.toContain("broken secret");
		}
	});

	test("consumer cancellation aborts the upstream fetch signal and releases its reader", async () => {
		let upstreamSignal: AbortSignal | null | undefined;
		let cancelled = false;
		const response = await adapter((_url, init) => {
			upstreamSignal = init.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
					start(controller) {
						controller.enqueue(
							encode.encode(
								frame({ delta: "first", type: "response.output_text.delta" })
							)
						);
					},
				})
			);
		}).chat(input, signal());
		const reader = responseReader(response);
		await reader.read();
		await reader.cancel();
		await Promise.resolve();
		expect(upstreamSignal?.aborted).toBe(true);
		expect(cancelled).toBe(true);
	});

	test("request cancellation during stream yields cancellation without completion", async () => {
		const controller = new AbortController();
		const response = await adapter(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(
								encode.encode(
									frame({ delta: "first", type: "response.output_text.delta" })
								)
							);
						},
					})
				)
		).chat(input, controller.signal);
		const reader = responseReader(response);
		await reader.read();
		controller.abort();
		let remainder = "";
		let ended = false;
		while (!ended) {
			// biome-ignore lint/performance/noAwaitInLoops: one response reader emits its packets in order.
			const chunk = await reader.read();
			ended = chunk.done;
			if (chunk.done) {
				break;
			}
			remainder += new TextDecoder().decode(chunk.value);
		}
		expect(remainder).toContain("отменён");
		expect(remainder).not.toContain('"type":"done"');
	});

	test("models fetches slug/display_name, filters hidden, and clearly marks catalog fallback", async () => {
		const remote = adapter((url) => {
			expect(url).toBe(
				"https://chatgpt.com/backend-api/codex/models?client_version=0.156.1"
			);
			return Response.json({
				models: [
					{ display_name: "GPT Test", slug: "gpt-test", visibility: "list" },
					{
						display_name: "CLI visible",
						slug: "cli-visible",
						visibility: "visible",
					},
					{ display_name: "CLI default", slug: "cli-default" },
					{ slug: "hidden", visibility: "hide" },
				],
			});
		});
		expect(await remote.models(base.id)).toEqual({
			models: [
				{ id: "gpt-test", name: "GPT Test" },
				{ id: "cli-visible", name: "CLI visible" },
				{ id: "cli-default", name: "CLI default" },
			],
			source: "remote",
		});
		const fallback = await adapter(
			() => new Response("denied secret", { status: 403 }),
			{ ...base, authMode: "claude", provider: "claude" }
		).models(base.id);
		expect(fallback.source).toBe("catalog");
		expect(fallback.models.length).toBeGreaterThan(0);
		expect(fallback.error).toContain("стороннего приложения");
		expect(fallback.error).not.toContain("secret");
	});

	test("SIWC ChatGPT model picker includes only explicitly listed models in server order", async () => {
		const ai = adapter(
			(url) => {
				expect(url).toBe("https://api.openai.com/v1/models");
				return Response.json({
					models: [
						{ display_name: "Second", slug: "gpt-second", visibility: "list" },
						{ slug: "internal", visibility: "internal" },
						{ slug: "legacy-visible", visibility: "visible" },
						{ slug: "unclassified" },
						{ slug: "hidden", visibility: "hide" },
						{ display_name: "First", slug: "gpt-first", visibility: "list" },
					],
				});
			},
			{ ...base, authMode: "siwc" }
		);
		expect(await ai.models(base.id)).toEqual({
			models: [
				{ id: "gpt-second", name: "Second" },
				{ id: "gpt-first", name: "First" },
			],
			source: "remote",
		});
	});

	test("SIWC standard data-array model catalogs retain their ordinary identifiers", async () => {
		const ai = adapter(() => Response.json({ data: [{ id: "gpt-data" }] }), {
			...base,
			authMode: "siwc",
		});
		expect(await ai.models(base.id)).toEqual({
			models: [{ id: "gpt-data", name: "gpt-data" }],
			source: "remote",
		});
	});

	test("multi-line SSE data is parsed", async () => {
		const multiline =
			'event: response.output_text.delta\ndata: {\ndata: "type":"response.output_text.delta",\ndata: "delta":"line"\ndata: }\n\n';
		const result = await events(
			await adapter(() =>
				packets(
					multiline +
						frame({ response: { usage: {} }, type: "response.completed" })
				)
			).chat(input, signal())
		);
		expect(result[0]).toEqual({ text: "line", type: "text" });
	});
});

describe("local compatibility gateway", () => {
	test("chat completions supports streaming chunks with usage and nonstream JSON", async () => {
		const ai = adapter(() => packets(completed("output"), 17));
		const json = await (
			await ai.gateway(
				"/v1/chat/completions",
				{ messages: input.messages, model: input.model },
				base.id,
				signal()
			)
		).json();
		expect(json).toMatchObject({
			choices: [
				{
					finish_reason: "stop",
					message: { content: "output", role: "assistant" },
				},
			],
			object: "chat.completion",
			usage: { completion_tokens: 4, prompt_tokens: 10, total_tokens: 14 },
		});
		const text = await (
			await ai.gateway(
				"/v1/chat/completions",
				{
					messages: input.messages,
					model: input.model,
					stream: true,
					stream_options: { include_usage: true },
				},
				base.id,
				signal()
			)
		).text();
		expect(text).toContain('"content":"output"');
		expect(text).toContain('"choices":[]');
		expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
	});

	test("chat completions rejects tools rather than silently dropping them", async () => {
		let calls = 0;
		const ai = adapter(() => {
			calls += 1;
			return packets(completed());
		});
		await expect(
			ai.gateway(
				"/v1/chat/completions",
				{
					messages: input.messages,
					model: input.model,
					tools: [{ type: "function" }],
				},
				base.id,
				signal()
			)
		).rejects.toBeInstanceOf(AiError);
		expect(calls).toBe(0);
	});

	test("native Responses preserves functions and output structures and adapts mandatory Codex streaming", async () => {
		const raw = {
			input: [
				{ call_id: "call-1", output: "result", type: "function_call_output" },
				{ content: "rules", role: "system" },
			],
			model: input.model,
			store: true,
			stream: false,
			tool_choice: "auto",
			tools: [
				{ name: "inspect", parameters: { type: "object" }, type: "function" },
			],
		};
		const ai = adapter((_url, init) => {
			const body = JSON.parse(String(init.body));
			expect(body.tools).toEqual(raw.tools);
			expect(body.input).toEqual([
				raw.input[0],
				{ content: "rules", role: "developer" },
			]);
			expect(body).toMatchObject({
				instructions: "",
				store: false,
				stream: true,
				tool_choice: "auto",
			});
			for (const field of [
				"unknown_field",
				"max_output_tokens",
				"truncation",
				"background",
			]) {
				expect(body[field]).toBeUndefined();
			}
			return packets(
				frame({
					response: {
						id: "resp-function",
						output: [
							{
								arguments: "{}",
								call_id: "call-2",
								name: "inspect",
								type: "function_call",
							},
						],
						usage: {},
					},
					type: "response.completed",
				})
			);
		});
		expect(
			await (await ai.gateway("/v1/responses", raw, base.id, signal())).json()
		).toMatchObject({
			id: "resp-function",
			output: [{ name: "inspect", type: "function_call" }],
		});
	});

	test("native Claude preserves tool/content blocks and stream events", async () => {
		const raw = {
			messages: [
				{
					content: [
						{ content: "result", tool_use_id: "tool-1", type: "tool_result" },
					],
					role: "user",
				},
			],
			model: "claude-test",
			stream: true,
			system: [
				{ cache_control: { type: "ephemeral" }, text: "rules", type: "text" },
			],
			tools: [{ input_schema: { type: "object" }, name: "inspect" }],
		};
		const ai = adapter(
			(_url, init) => {
				expect(JSON.parse(String(init.body))).toEqual({
					max_tokens: 4096,
					messages: raw.messages,
					model: raw.model,
					stream: true,
					system: raw.system,
					tools: raw.tools,
				});
				return packets(
					frame(
						{
							content_block: {
								id: "tool-2",
								input: {},
								name: "inspect",
								type: "tool_use",
							},
							type: "content_block_start",
						},
						"content_block_start"
					) + frame({ type: "message_stop" }, "message_stop")
				);
			},
			{ ...base, authMode: "claude", provider: "claude" }
		);
		const text = await (
			await ai.gateway("/v1/messages", raw, base.id, signal())
		).text();
		expect(text).toContain('"tool_use"');
		expect(text).toContain("event: message_stop");
	});

	test("native SIWC nonstream aggregates mandatory upstream SSE only after completed inference", async () => {
		const tools = [
			{ name: "inspect", parameters: { type: "object" }, type: "function" },
		];
		const ai = adapter(
			(url, init) => {
				expect(url).toBe("https://api.openai.com/v1/responses");
				expect(JSON.parse(String(init.body))).toMatchObject({
					max_output_tokens: 100,
					store: false,
					stream: true,
					tools,
				});
				return packets(completed("SIWC output"), 17);
			},
			{ ...base, authMode: "siwc" }
		);
		expect(
			await (
				await ai.gateway(
					"/v1/responses",
					{
						input: "question",
						max_output_tokens: 100,
						model: input.model,
						store: true,
						stream: false,
						tools,
					},
					base.id,
					signal()
				)
			).json()
		).toMatchObject({
			id: "resp-test",
			output: [
				{
					content: [{ text: "SIWC output", type: "output_text" }],
					type: "message",
				},
			],
			usage: { input_tokens: 10, output_tokens: 4 },
		});
		await expect(
			ai.gateway(
				"/v1/messages",
				{ messages: input.messages, model: "claude-test" },
				base.id,
				signal()
			)
		).rejects.toBeInstanceOf(AiError);
	});

	test.each([
		frame({ delta: "partial", type: "response.output_text.delta" }),
		frame({ delta: "partial", type: "response.output_text.delta" }) +
			"data: [DONE]\n\n",
		frame({
			response: {
				error: {
					code: "subscription_sharing_usage_limit_exceeded",
					message: "private-token",
				},
			},
			type: "response.failed",
		}),
		frame({ type: "response.incomplete" }),
	])(
		"native SIWC nonstream cannot succeed on an interrupted or failed stream: %#",
		async (fixture) => {
			const ai = adapter(() => packets(fixture, 7), {
				...base,
				authMode: "siwc",
			});
			await expect(
				ai.gateway(
					"/v1/responses",
					{ input: "question", model: input.model, stream: false },
					base.id,
					signal()
				)
			).rejects.toMatchObject({ status: 502 });
		}
	);

	test("native Claude nonstream retains the provider's JSON response", async () => {
		const payload = {
			content: [{ text: "Claude output", type: "text" }],
			id: "msg-native",
			type: "message",
		};
		const ai = adapter(
			(_url, init) => {
				expect(JSON.parse(String(init.body)).stream).toBe(false);
				return Response.json(payload);
			},
			{ ...base, authMode: "claude", provider: "claude" }
		);
		expect(
			await (
				await ai.gateway(
					"/v1/messages",
					{ messages: input.messages, model: "claude-test", stream: false },
					base.id,
					signal()
				)
			).json()
		).toEqual(payload);
	});

	test("native stream provider errors are redacted and never marked complete", async () => {
		const text = await (
			await adapter(() =>
				packets(
					frame({
						error: { message: "private-token" },
						type: "response.failed",
					})
				)
			).gateway(
				"/v1/responses",
				{ input: "question", model: input.model, stream: true },
				base.id,
				signal()
			)
		).text();
		expect(text).toContain("event: error");
		expect(text).not.toContain("private-token");
		expect(text).not.toContain("response.completed");
	});
});

test("native requests reject unknown fields and unsupported Codex controls before upstream", async () => {
	let calls = 0;
	const ai = adapter(() => {
		calls += 1;
		return packets(completed());
	});
	const controls = {
		arbitrary_url: "https://attacker.invalid",
		background: false,
		max_output_tokens: 5,
		temperature: 0.5,
		top_p: 1,
		truncation: "disabled",
	};
	await Promise.all(
		Object.entries(controls).map(async ([field, value]) => {
			await expect(
				ai.gateway(
					"/v1/responses",
					{ input: "question", model: input.model, [field]: value },
					base.id,
					signal()
				)
			).rejects.toMatchObject({ status: 400 });
		})
	);
	const claude = adapter(
		() => {
			calls += 1;
			return Response.json({});
		},
		{ ...base, authMode: "claude", provider: "claude" }
	);
	await expect(
		claude.gateway(
			"/v1/messages",
			{
				arbitrary_option: true,
				messages: input.messages,
				model: "claude-test",
			},
			base.id,
			signal()
		)
	).rejects.toMatchObject({ status: 400 });
	expect(calls).toBe(0);
});

test("chat input budget counts UTF-8 bytes", async () => {
	let calls = 0;
	const ai = adapter(() => {
		calls += 1;
		return packets(completed());
	});
	await expect(
		ai.chat(
			{ ...input, messages: [{ content: "я".repeat(140_000), role: "user" }] },
			signal()
		)
	).rejects.toMatchObject({ status: 400 });
	expect(calls).toBe(0);
});

test("stream backpressure does not eagerly consume the whole upstream", async () => {
	let pulls = 0;
	let cancelled = false;
	const response = await adapter(
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
					pull(controller) {
						pulls += 1;
						controller.enqueue(
							encode.encode(
								frame({ delta: "small", type: "response.output_text.delta" })
							)
						);
					},
				})
			)
	).chat(input, signal());
	await Promise.resolve();
	await Promise.resolve();
	expect(pulls).toBeLessThan(10);
	await response.body?.cancel();
	expect(cancelled).toBe(true);
});

test("nested terminal provider errors are redacted", async () => {
	const text = await (
		await adapter(() =>
			packets(
				frame({
					response: { error: { message: "private-token" } },
					type: "response.completed",
				})
			)
		).gateway(
			"/v1/responses",
			{ input: "question", model: input.model, stream: true },
			base.id,
			signal()
		)
	).text();
	expect(text).toContain("event: error");
	expect(text).not.toContain("private-token");
	expect(text).not.toContain("response.completed");
});
