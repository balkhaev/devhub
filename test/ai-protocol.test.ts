import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	AiInference,
	type AiLifecycleEvent,
	AiUpstreamError,
} from "../src/ai/inference";
import { type AiCredential, AiError } from "../src/ai/types";

const credential: AiCredential = {
	accessToken: "fake-secret",
	authMode: "siwc",
	clientId: "test",
	id: "account",
	label: "Test",
	provider: "codex",
	source: "oauth",
};
const encoder = new TextEncoder();
const credentialFingerprint = createHash("sha256")
	.update(credential.accessToken)
	.digest("hex");
const SSE_SEPARATOR = /\r?\n\r?\n/;
const signal = () => new AbortController().signal;
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function upstream(events: unknown[]): Response {
	const bytes = encoder.encode(events.map(frame).join(""));
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === bytes.length) {
					controller.close();
					return;
				}
				const start = offset;
				offset += 1;
				controller.enqueue(bytes.slice(start, offset));
			},
		})
	);
}
function adapter(
	reply: (body: Record<string, unknown>, init: RequestInit) => Response,
	mode: AiCredential["authMode"] = "siwc"
): AiInference {
	return new AiInference({
		credential: () =>
			Promise.resolve({
				...credential,
				authMode: mode,
				provider: mode === "claude" ? "claude" : "codex",
			}),
		fetch: ((_url: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				reply(JSON.parse(String(init?.body)), init ?? {})
			)) as unknown as typeof fetch,
	});
}
const request = {
	messages: [{ content: "Hello", role: "user" }],
	model: "test-model",
};
const weatherFunction = {
	description: "Weather lookup",
	name: "weather",
	parameters: { properties: { city: { type: "string" } }, type: "object" },
	strict: false,
};
const tools = [{ function: weatherFunction, type: "function" }];
const terminal = (
	output: unknown[] = [],
	extra: Record<string, unknown> = {}
) => ({
	response: {
		id: "resp-test",
		output,
		usage: { input_tokens: 10, output_tokens: 4 },
		...extra,
	},
	type: "response.completed",
});
const toolItem = (id: string, name: string, args: string) => ({
	arguments: args,
	call_id: id,
	id: `fc-${id}`,
	name,
	type: "function_call",
});
function chunks(text: string): Record<string, unknown>[] {
	return text
		.split(SSE_SEPARATOR)
		.flatMap((line) =>
			line.startsWith("data: ") && !line.includes("[DONE]")
				? [JSON.parse(line.slice(6))]
				: []
		);
}

describe("rich completion translation", () => {
	test("native SIWC flat tools preserve namespaced call replay and caller-owned namespaces", async () => {
		const calls = [
			toolItem("first", "weather", "{}"),
			{ ...toolItem("second", "existing", "{}"), namespace: "devhub" },
			{
				call_id: "third",
				input: "payload",
				name: "custom",
				type: "custom_tool_call",
			},
		];
		const body = {
			input: calls,
			model: request.model,
			tool_choice: { name: "weather", type: "function" },
			tools: [
				{
					name: "devhub",
					tools: [{ name: "existing", type: "function" }],
					type: "namespace",
				},
				{ ...weatherFunction, type: "function" },
				{ name: "custom", type: "custom" },
			],
		};
		const original = structuredClone(body);
		const ai = adapter((actual) => {
			expect(actual.input).toEqual([
				{ ...calls[0], namespace: "devhub_functions" },
				calls[1],
				{ ...calls[2], namespace: "devhub_functions" },
			]);
			expect(actual.tool_choice).toEqual(body.tool_choice);
			expect(actual.tools).toEqual([
				body.tools[0],
				{
					name: "devhub_functions",
					tools: body.tools.slice(1),
					type: "namespace",
				},
			]);
			return upstream([terminal()]);
		});
		await ai.gateway("/v1/responses", body, credential.id, signal());
		expect(body).toEqual(original);
	});
	test.each(["siwc", "codex"] as const)(
		"OpenAI %s preserves images, inline files, call identities, tool results and structured output",
		async (mode) => {
			const body = {
				messages: [
					{ content: [{ text: "Rules", type: "text" }], role: "system" },
					{ content: "More rules", role: "developer" },
					{
						content: [
							{ text: "Image", type: "text" },
							{
								image_url: {
									detail: "high",
									url: "data:image/png;base64,YQ==",
								},
								type: "image_url",
							},
							{
								file: {
									file_data: "data:application/pdf;base64,Yg==",
									filename: "x.pdf",
								},
								type: "file",
							},
						],
						role: "user",
					},
					{
						content: null,
						role: "assistant",
						tool_calls: [
							{
								function: { arguments: '{"city":"Москва"}', name: "weather" },
								id: "call-1",
								type: "function",
							},
						],
					},
					{
						content: [{ text: "Result", type: "text" }],
						role: "tool",
						tool_call_id: "call-1",
					},
				],
				model: request.model,
				parallel_tool_calls: false,
				reasoning_effort: "low",
				response_format: {
					json_schema: {
						name: "answer",
						schema: { type: "object" },
						strict: false,
					},
					type: "json_schema",
				},
				tool_choice: { function: { name: "weather" }, type: "function" },
				tools,
			};
			const original = structuredClone(body);
			const ai = adapter((actual) => {
				expect(actual).toMatchObject({
					model: request.model,
					reasoning: { effort: "low" },
					store: false,
					stream: true,
					text: {
						format: {
							name: "answer",
							schema: { type: "object" },
							strict: false,
							type: "json_schema",
						},
					},
					tool_choice: { name: "weather", type: "function" },
				});
				expect(actual.input).toEqual([
					{
						content: [{ text: "Rules", type: "input_text" }],
						role: "developer",
					},
					{
						content: [{ text: "More rules", type: "input_text" }],
						role: "developer",
					},
					{
						content: [
							{ text: "Image", type: "input_text" },
							{
								detail: "high",
								image_url: "data:image/png;base64,YQ==",
								type: "input_image",
							},
							{
								file_data: "data:application/pdf;base64,Yg==",
								filename: "x.pdf",
								type: "input_file",
							},
						],
						role: "user",
					},
					{
						arguments: '{"city":"Москва"}',
						call_id: "call-1",
						name: "weather",
						...(mode === "siwc" ? { namespace: "devhub" } : {}),
						type: "function_call",
					},
					{
						call_id: "call-1",
						output: [{ text: "Result", type: "input_text" }],
						type: "function_call_output",
					},
				]);
				const converted = [{ type: "function", ...weatherFunction }];
				expect(actual.tools).toEqual(
					mode === "siwc"
						? [{ name: "devhub", tools: converted, type: "namespace" }]
						: converted
				);
				return upstream([
					terminal([
						{
							content: [{ text: "Done", type: "output_text" }],
							type: "message",
						},
					]),
				]);
			}, mode);
			expect(
				await (
					await ai.gateway(
						"/v1/chat/completions",
						body,
						credential.id,
						signal()
					)
				).json()
			).toMatchObject({ choices: [{ message: { content: "Done" } }] });
			expect(body).toEqual(original);
		}
	);

	test("Claude keeps parallel tool results adjacent and converts image/PDF content without renaming tools", async () => {
		const ai = adapter((actual, init) => {
			expect(new Headers(init.headers).get("User-Agent")).toBe("DevHub/0.1");
			expect(actual).toMatchObject({
				max_tokens: 77,
				stop_sequences: ["END"],
				system: "Rules",
				temperature: 0.2,
				tool_choice: {
					disable_parallel_tool_use: true,
					name: "weather",
					type: "tool",
				},
				tools: [
					{
						input_schema: weatherFunction.parameters,
						name: "weather",
						strict: false,
					},
				],
				top_p: 0.5,
			});
			expect(actual.messages).toEqual([
				{
					content: [
						{
							source: { data: "YQ==", media_type: "image/png", type: "base64" },
							type: "image",
						},
						{
							source: { type: "url", url: "https://example.com/image.png" },
							type: "image",
						},
						{
							source: {
								data: "Yg==",
								media_type: "application/pdf",
								type: "base64",
							},
							title: "x.pdf",
							type: "document",
						},
					],
					role: "user",
				},
				{
					content: [
						{
							id: "call-1",
							input: { city: "Moscow" },
							name: "weather",
							type: "tool_use",
						},
						{
							id: "call-2",
							input: { city: "Paris" },
							name: "weather",
							type: "tool_use",
						},
					],
					role: "assistant",
				},
				{
					content: [
						{ content: "First", tool_use_id: "call-1", type: "tool_result" },
						{ content: "Second", tool_use_id: "call-2", type: "tool_result" },
						{ text: "Finish", type: "text" },
					],
					role: "user",
				},
			]);
			return upstream([
				{
					delta: { stop_reason: "end_turn" },
					type: "message_delta",
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			]);
		}, "claude");
		await (
			await ai.gateway(
				"/v1/chat/completions",
				{
					max_tokens: 77,
					messages: [
						{ content: "Rules", role: "developer" },
						{
							content: [
								{
									image_url: { url: "data:image/png;base64,YQ==" },
									type: "image_url",
								},
								{
									image_url: { url: "https://example.com/image.png" },
									type: "image_url",
								},
								{
									file: {
										file_data: "data:application/pdf;base64,Yg==",
										filename: "x.pdf",
									},
									type: "file",
								},
							],
							role: "user",
						},
						{
							content: null,
							role: "assistant",
							tool_calls: ["Moscow", "Paris"].map((city, index) => ({
								function: {
									arguments: JSON.stringify({ city }),
									name: "weather",
								},
								id: `call-${index + 1}`,
								type: "function",
							})),
						},
						{ content: "First", role: "tool", tool_call_id: "call-1" },
						{ content: "Second", role: "tool", tool_call_id: "call-2" },
						{ content: "Finish", role: "user" },
					],
					model: "claude-test",
					parallel_tool_calls: false,
					stop: "END",
					temperature: 0.2,
					tool_choice: { function: { name: "weather" }, type: "function" },
					tools,
					top_p: 0.5,
				},
				credential.id,
				signal()
			)
		).text();
	});

	test("malformed/orphan/missing tools and unknown content/parameters never reach upstream", async () => {
		let calls = 0;
		const ai = adapter(() => {
			calls += 1;
			return upstream([terminal()]);
		});
		const assistant = {
			content: null,
			role: "assistant",
			tool_calls: [
				{
					function: { arguments: "{}", name: "weather" },
					id: "x",
					type: "function",
				},
			],
		};
		await Promise.all(
			[
				{
					...request,
					messages: [{ content: "orphan", role: "tool", tool_call_id: "x" }],
				},
				{ ...request, messages: [assistant] },
				{
					...request,
					messages: [assistant, { content: "interrupt", role: "user" }],
				},
				{
					...request,
					messages: [
						{
							content: null,
							role: "assistant",
							tool_calls: [
								{
									function: { arguments: "secret-bad-json", name: "weather" },
									id: "x",
									type: "function",
								},
							],
						},
						{ content: "result", role: "tool", tool_call_id: "x" },
					],
				},
				{
					...request,
					messages: [
						{
							content: [
								{ input_audio: { data: "secret" }, type: "input_audio" },
							],
							role: "user",
						},
					],
				},
				{ ...request, logprobs: true },
				{
					...request,
					tool_choice: { function: { name: "missing" }, type: "function" },
					tools,
				},
			].map(async (body) => {
				await expect(
					ai.gateway("/v1/chat/completions", body, credential.id, signal())
				).rejects.toMatchObject({ status: 400 });
			})
		);
		expect(calls).toBe(0);
	});

	test("SIWC rejects unsupported plan controls and hosted tools before upstream", async () => {
		let calls = 0;
		const ai = adapter(() => {
			calls += 1;
			return upstream([terminal()]);
		});
		await Promise.all(
			Object.entries({
				background: false,
				conversation: "x",
				max_output_tokens: 100,
				max_tool_calls: 5,
				metadata: {},
				previous_response_id: "resp",
				prompt_cache_retention: "in_memory",
				safety_identifier: "x",
				temperature: 0.1,
				top_p: 1,
				truncation: "disabled",
			}).map(async ([field, value]) => {
				await expect(
					ai.gateway(
						"/v1/responses",
						{ input: "Hello", model: request.model, [field]: value },
						credential.id,
						signal()
					)
				).rejects.toMatchObject({ status: 400 });
			})
		);
		await expect(
			ai.gateway(
				"/v1/responses",
				{
					input: "Hello",
					model: request.model,
					tools: [{ type: "tool_search" }],
				},
				credential.id,
				signal()
			)
		).rejects.toMatchObject({ status: 400 });
		await expect(
			ai.gateway(
				"/v1/chat/completions",
				{ ...request, max_tokens: 100 },
				credential.id,
				signal()
			)
		).rejects.toMatchObject({ status: 400 });
		expect(calls).toBe(0);
	});
});

describe("tool-aware completion streams", () => {
	const native = [
		{
			item: toolItem("call-1", "weather", ""),
			output_index: 1,
			type: "response.output_item.added",
		},
		{
			delta: '{"city":',
			output_index: 1,
			type: "response.function_call_arguments.delta",
		},
		{
			item: toolItem("call-2", "time", ""),
			output_index: 3,
			type: "response.output_item.added",
		},
		{
			delta: "{}",
			output_index: 3,
			type: "response.function_call_arguments.delta",
		},
		{
			delta: '"Москва"}',
			output_index: 1,
			type: "response.function_call_arguments.delta",
		},
		{
			arguments: '{"city":"Москва"}',
			output_index: 1,
			type: "response.function_call_arguments.done",
		},
		terminal(
			[
				{ type: "reasoning" },
				toolItem("call-1", "weather", '{"city":"Москва"}'),
				{ type: "reasoning" },
				toolItem("call-2", "time", "{}"),
			],
			{
				usage: {
					input_tokens: 10,
					input_tokens_details: { cached_tokens: 2 },
					output_tokens: 4,
					output_tokens_details: { reasoning_tokens: 1 },
				},
			}
		),
	];
	test("Responses tools stream argument fragments and independent sequential indices", async () => {
		const response = await adapter(() => upstream(native)).gateway(
			"/v1/chat/completions",
			{ ...request, stream: true, stream_options: { include_usage: true } },
			credential.id,
			signal()
		);
		const text = await response.text();
		const output = chunks(text);
		expect(output).toContainEqual(
			expect.objectContaining({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									function: { arguments: "", name: "weather" },
									id: "call-1",
									index: 0,
									type: "function",
								},
							],
						},
						finish_reason: null,
						index: 0,
					},
				],
			})
		);
		expect(output).toContainEqual(
			expect.objectContaining({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									function: { arguments: "", name: "time" },
									id: "call-2",
									index: 1,
									type: "function",
								},
							],
						},
						finish_reason: null,
						index: 0,
					},
				],
			})
		);
		expect(text).toContain('"finish_reason":"tool_calls"');
		expect(output.at(-1)).toMatchObject({
			choices: [],
			usage: {
				completion_tokens: 4,
				completion_tokens_details: { reasoning_tokens: 1 },
				prompt_tokens: 10,
				prompt_tokens_details: { cached_tokens: 2 },
			},
		});
		expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
	});
	test("Responses tool-only JSON aggregates arguments once and preserves null content", async () => {
		expect(
			await (
				await adapter(() => upstream(native)).gateway(
					"/v1/chat/completions",
					request,
					credential.id,
					signal()
				)
			).json()
		).toMatchObject({
			choices: [
				{
					finish_reason: "tool_calls",
					message: {
						content: null,
						role: "assistant",
						tool_calls: [
							{
								function: { arguments: '{"city":"Москва"}', name: "weather" },
								id: "call-1",
							},
							{ function: { arguments: "{}", name: "time" }, id: "call-2" },
						],
					},
				},
			],
		});
	});
	test("Claude maps sparse block indices, partial JSON, cache usage and tool stop reason", async () => {
		const claudeEvents = [
			{
				message: {
					usage: {
						cache_creation_input_tokens: 2,
						cache_read_input_tokens: 3,
						input_tokens: 5,
					},
				},
				type: "message_start",
			},
			{
				content_block: {
					id: "t1",
					input: {},
					name: "weather",
					type: "tool_use",
				},
				index: 2,
				type: "content_block_start",
			},
			{
				delta: { partial_json: '{"city":', type: "input_json_delta" },
				index: 2,
				type: "content_block_delta",
			},
			{
				delta: { partial_json: '"Москва"}', type: "input_json_delta" },
				index: 2,
				type: "content_block_delta",
			},
			{ index: 2, type: "content_block_stop" },
			{
				content_block: { id: "t2", input: {}, name: "time", type: "tool_use" },
				index: 7,
				type: "content_block_start",
			},
			{ index: 7, type: "content_block_stop" },
			{
				delta: { stop_reason: "tool_use" },
				type: "message_delta",
				usage: { output_tokens: 4 },
			},
			{ type: "message_stop" },
		];
		const ai = adapter(() => upstream(claudeEvents), "claude");
		expect(
			await (
				await ai.gateway(
					"/v1/chat/completions",
					request,
					credential.id,
					signal()
				)
			).json()
		).toMatchObject({
			choices: [
				{
					finish_reason: "tool_calls",
					message: {
						content: null,
						tool_calls: [
							{ function: { arguments: '{"city":"Москва"}' }, id: "t1" },
							{ function: { arguments: "{}" }, id: "t2" },
						],
					},
				},
			],
			usage: {
				completion_tokens: 4,
				prompt_tokens: 10,
				prompt_tokens_details: { cache_creation_tokens: 2, cached_tokens: 3 },
				total_tokens: 14,
			},
		});
		const text = await (
			await ai.gateway(
				"/v1/chat/completions",
				{ ...request, stream: true },
				credential.id,
				signal()
			)
		).text();
		expect(chunks(text)).toContainEqual(
			expect.objectContaining({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									function: { arguments: "", name: "time" },
									id: "t2",
									index: 1,
									type: "function",
								},
							],
						},
						finish_reason: null,
						index: 0,
					},
				],
			})
		);
		expect(text).toContain('"finish_reason":"tool_calls"');
	});
	test("explicit output-token termination maps to length, while unknown incomplete termination fails", async () => {
		const ai = adapter(() =>
			upstream([
				{
					response: {
						id: "resp-limited",
						incomplete_details: { reason: "max_output_tokens" },
						output: [
							{
								content: [{ text: "partial", type: "output_text" }],
								type: "message",
							},
						],
					},
					type: "response.incomplete",
				},
			])
		);
		expect(
			await (
				await ai.gateway(
					"/v1/chat/completions",
					request,
					credential.id,
					signal()
				)
			).json()
		).toMatchObject({
			choices: [{ finish_reason: "length", message: { content: "partial" } }],
		});
		const bad = adapter(() =>
			upstream([
				{
					response: { incomplete_details: { reason: "unknown" } },
					type: "response.incomplete",
				},
			])
		);
		await expect(
			bad.gateway("/v1/chat/completions", request, credential.id, signal())
		).rejects.toMatchObject({ status: 502 });
	});
	test("Claude max_tokens maps to length and OpenAI refusal maps to content_filter", async () => {
		const claude = adapter(
			() =>
				upstream([
					{ delta: { stop_reason: "max_tokens" }, type: "message_delta" },
					{ type: "message_stop" },
				]),
			"claude"
		);
		expect(
			await (
				await claude.gateway(
					"/v1/chat/completions",
					request,
					credential.id,
					signal()
				)
			).json()
		).toMatchObject({ choices: [{ finish_reason: "length" }] });
		const openai = adapter(() =>
			upstream([
				terminal([
					{
						content: [{ refusal: "Cannot help", type: "refusal" }],
						type: "message",
					},
				]),
			])
		);
		expect(
			await (
				await openai.gateway(
					"/v1/chat/completions",
					request,
					credential.id,
					signal()
				)
			).json()
		).toMatchObject({
			choices: [
				{
					finish_reason: "content_filter",
					message: { content: null, refusal: "Cannot help" },
				},
			],
		});
	});
});

describe("routing lifecycle", () => {
	test.each([false, true])(
		"refreshed grant fingerprint belongs to the dispatched request, stream=%s",
		async (stream) => {
			const refreshed = "refreshed-fake-secret";
			const refreshedFingerprint = createHash("sha256")
				.update(refreshed)
				.digest("hex");
			let calls = 0;
			const events: AiLifecycleEvent[] = [];
			const ai = new AiInference({
				credential: (_id, forceRefresh) =>
					Promise.resolve({
						...credential,
						accessToken: forceRefresh ? refreshed : credential.accessToken,
					}),
				fetch: ((_url: string | URL | Request, init?: RequestInit) => {
					calls += 1;
					if (calls === 1) {
						return Promise.resolve(new Response("", { status: 401 }));
					}
					expect(new Headers(init?.headers).get("authorization")).toBe(
						`Bearer ${refreshed}`
					);
					return Promise.resolve(
						upstream([
							{
								response: {
									error: { code: "subscription_sharing_invalid_user" },
								},
								type: "response.failed",
							},
						])
					);
				}) as unknown as typeof fetch,
			});
			const pending = ai.gateway(
				"/v1/chat/completions",
				{ ...request, stream },
				credential.id,
				signal(),
				(event) => events.push(event)
			);
			if (stream) {
				const text = await (await pending).text();
				expect(events).toEqual([
					{
						code: "subscription_sharing_invalid_user",
						credentialFingerprint: refreshedFingerprint,
						kind: "error",
						retryAfterMs: undefined,
						status: 401,
					},
				]);
				expect(text).not.toContain(refreshedFingerprint);
				expect(text).not.toContain(refreshed);
			} else {
				await expect(pending).rejects.toMatchObject({
					credentialFingerprint: refreshedFingerprint,
					retryable: false,
					upstreamStatus: 401,
				});
				expect(events).toEqual([]);
			}
			expect(calls).toBe(2);
		}
	);
	test("HTTP admission error identifies the final dispatched refreshed grant", async () => {
		const refreshed = "refreshed-fake-secret";
		const ai = new AiInference({
			credential: (_id, forceRefresh) =>
				Promise.resolve({
					...credential,
					accessToken: forceRefresh ? refreshed : credential.accessToken,
				}),
			fetch: (() =>
				Promise.resolve(
					new Response("", { status: 401 })
				)) as unknown as typeof fetch,
		});
		await expect(
			ai.gateway("/v1/chat/completions", request, credential.id, signal())
		).rejects.toMatchObject({
			credentialFingerprint: createHash("sha256")
				.update(refreshed)
				.digest("hex"),
			retryable: true,
			upstreamStatus: 401,
		});
	});
	test.each([
		{},
		{ id: "resp-failed", output: [], status: "failed" },
		{ id: "resp-cancelled", output: [], status: "cancelled" },
	])(
		"malformed accepted Responses terminal %j cannot report success",
		async (payload) => {
			await Promise.all(
				["/v1/responses", "/v1/chat/completions"].flatMap((path) =>
					[false, true].map(async (stream) => {
						const events: AiLifecycleEvent[] = [];
						let calls = 0;
						const ai = adapter(() => {
							calls += 1;
							return upstream([
								{ response: payload, type: "response.completed" },
							]);
						});
						const pending = ai.gateway(
							path as "/v1/responses" | "/v1/chat/completions",
							path === "/v1/responses"
								? { input: "Hello", model: request.model, stream }
								: { ...request, stream },
							credential.id,
							signal(),
							(event) => events.push(event)
						);
						if (stream) {
							const text = await (await pending).text();
							expect(text).toContain('"error"');
							expect(text).not.toContain("[DONE]");
							expect(events).toEqual([
								{ credentialFingerprint, kind: "error", status: 502 },
							]);
						} else {
							await expect(pending).rejects.toMatchObject({ status: 502 });
							expect(events).toEqual([]);
						}
						expect(calls).toBe(1);
					})
				)
			);
			const events: AiLifecycleEvent[] = [];
			const ai = adapter(() =>
				upstream([{ response: payload, type: "response.completed" }])
			);
			const output = await (
				await ai.chat(
					{
						accountId: credential.id,
						messages: [{ content: "Hello", role: "user" }],
						model: request.model,
					},
					signal(),
					(event) => events.push(event)
				)
			).text();
			expect(output).toContain('"type":"error"');
			expect(output).not.toContain('"type":"done"');
			expect(events).toEqual([
				{ credentialFingerprint, kind: "error", status: 502 },
			]);
		}
	);
	test("accepted nonstream quota failures are never retryable despite a 429 result", async () => {
		const events: AiLifecycleEvent[] = [];
		const ai = adapter(() =>
			upstream([
				{
					response: {
						error: {
							code: "subscription_sharing_usage_limit_exceeded",
							message: "fake-secret",
						},
					},
					type: "response.failed",
				},
			])
		);
		await expect(
			ai.gateway(
				"/v1/chat/completions",
				request,
				credential.id,
				signal(),
				(event) => events.push(event)
			)
		).rejects.toMatchObject({
			code: "subscription_sharing_usage_limit_exceeded",
			retryable: false,
			upstreamStatus: 429,
		});
		expect(events).toEqual([]);
	});
	test("accepted malformed Claude JSON cannot complete or be retried", async () => {
		const events: AiLifecycleEvent[] = [];
		const ai = adapter(
			() => Response.json({ private_prompt: "fake-secret" }),
			"claude"
		);
		await expect(
			ai.gateway("/v1/messages", request, credential.id, signal(), (event) =>
				events.push(event)
			)
		).rejects.toMatchObject({ status: 502 });
		expect(events).toEqual([]);
	});
	test("upstream admission errors expose only status/retry hints and never callback before return", async () => {
		for (const status of [401, 403, 429, 503]) {
			const events: AiLifecycleEvent[] = [];
			let calls = 0;
			const ai = adapter(() => {
				calls += 1;
				return new Response("private prompt fake-secret", {
					headers: { "retry-after": "1.5" },
					status,
				});
			});
			try {
				// biome-ignore lint/performance/noAwaitInLoops: each admission status is an independent fixture.
				await ai.gateway(
					"/v1/chat/completions",
					request,
					credential.id,
					signal(),
					(event) => events.push(event)
				);
				throw new Error("Expected upstream rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(AiUpstreamError);
				expect(error).toMatchObject({
					retryAfterMs: 1500,
					retryable: status === 401 || status === 429,
					upstreamStatus: status,
				});
				expect((error as Error).message).not.toContain("fake-secret");
			}
			expect(events).toEqual([]);
			expect(calls).toBe(status === 401 ? 2 : 1);
		}
	});
	test("credential refresh rejection can fail over before any inference request", async () => {
		let calls = 0;
		const ai = new AiInference({
			credential: () => Promise.reject(new AiError("fake-secret", 401)),
			fetch: (() => {
				calls += 1;
				return Promise.resolve(upstream([terminal()]));
			}) as unknown as typeof fetch,
		});
		await expect(
			ai.gateway("/v1/chat/completions", request, credential.id, signal())
		).rejects.toMatchObject({ retryable: true, upstreamStatus: 401 });
		expect(calls).toBe(0);
	});
	test("completion and cancellation release once per response without mixing concurrent callbacks", async () => {
		const first: AiLifecycleEvent[] = [];
		const second: AiLifecycleEvent[] = [];
		const ai = adapter(() => upstream([terminal()]));
		const responses = await Promise.all([
			ai.gateway(
				"/v1/chat/completions",
				{ ...request, stream: true },
				credential.id,
				signal(),
				(event) => first.push(event)
			),
			ai.gateway(
				"/v1/chat/completions",
				request,
				credential.id,
				signal(),
				(event) => second.push(event)
			),
		]);
		await Promise.all(responses.map((response) => response.text()));
		expect(first).toEqual([
			{
				credentialFingerprint,
				kind: "complete",
				status: 200,
				usage: { inputTokens: 10, outputTokens: 4 },
			},
		]);
		expect(second).toEqual(first);
	});
	test("late quota failures report safe machine codes but never replay or emit DONE", async () => {
		let calls = 0;
		const events: AiLifecycleEvent[] = [];
		const ai = adapter(() => {
			calls += 1;
			return upstream([
				{ delta: "partial", type: "response.output_text.delta" },
				{
					response: {
						error: {
							code: "subscription_sharing_usage_limit_exceeded",
							message: "fake-secret",
						},
					},
					type: "response.failed",
				},
			]);
		});
		const text = await (
			await ai.gateway(
				"/v1/chat/completions",
				{ ...request, stream: true },
				credential.id,
				signal(),
				(event) => events.push(event)
			)
		).text();
		expect(text).toContain("partial");
		expect(text).toContain("subscription_sharing_usage_limit_exceeded");
		expect(text).not.toContain("fake-secret");
		expect(text).not.toContain("[DONE]");
		expect(calls).toBe(1);
		expect(events).toEqual([
			{
				code: "subscription_sharing_usage_limit_exceeded",
				credentialFingerprint,
				kind: "error",
				retryAfterMs: undefined,
				status: 429,
			},
		]);
	});
	test("aborting an idle stream releases once and cancels the upstream reader", async () => {
		const events: AiLifecycleEvent[] = [];
		let cancelled = false;
		const abort = new AbortController();
		const ai = adapter(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
						start(controller) {
							controller.enqueue(
								encoder.encode(
									frame({ delta: "first", type: "response.output_text.delta" })
								)
							);
						},
					})
				)
		);
		const response = await ai.gateway(
			"/v1/chat/completions",
			{ ...request, stream: true },
			credential.id,
			abort.signal,
			(event) => events.push(event)
		);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Expected response body");
		}
		await reader.read();
		await reader.read();
		abort.abort();
		await reader.cancel();
		expect(events).toEqual([
			{ credentialFingerprint, kind: "cancel", status: 499 },
		]);
		expect(cancelled).toBe(true);
	});
	test("native streams and nonstream terminal aggregation report terminal usage", async () => {
		const events: AiLifecycleEvent[] = [];
		const ai = adapter(() => upstream([terminal()]));
		await (
			await ai.gateway(
				"/v1/responses",
				{ input: "Hello", model: request.model, stream: true },
				credential.id,
				signal(),
				(event) => events.push(event)
			)
		).text();
		await (
			await ai.gateway(
				"/v1/responses",
				{ input: "Hello", model: request.model, stream: false },
				credential.id,
				signal(),
				(event) => events.push(event)
			)
		).text();
		expect(events).toEqual([
			{
				credentialFingerprint,
				kind: "complete",
				status: 200,
				usage: { inputTokens: 10, outputTokens: 4 },
			},
			{
				credentialFingerprint,
				kind: "complete",
				status: 200,
				usage: { inputTokens: 10, outputTokens: 4 },
			},
		]);
	});
});
