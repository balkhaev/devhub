import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AiAccounts } from "../src/ai/accounts";
import { AiInference } from "../src/ai/inference";
import type { AiCredential } from "../src/ai/types";
import { clientToken } from "../src/client";
import { catalogueSchema } from "../src/config";
import { startHub } from "../src/server";

const PRIVATE_ACCESS = "test-access-secret-never-public";
const PRIVATE_REFRESH = "test-refresh-secret-never-public";
const PRIVATE_ID = "test-id-secret-never-public";
const CREDENTIAL: AiCredential = {
	accessToken: PRIVATE_ACCESS,
	accountId: "workspace-test",
	authMode: "codex",
	clientId: "test-client",
	email: "fixture@example.test",
	expiresAt: Date.now() + 3_600_000,
	id: "fixture-codex",
	idToken: PRIVATE_ID,
	label: "Fixture account",
	provider: "codex",
	refreshToken: PRIVATE_REFRESH,
	source: "token",
};

type Upstream = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response> | Response;

async function fixture(upstream?: Upstream) {
	const root = await mkdtemp(join(tmpdir(), "devhub-ai-api-test-"));
	const home = join(root, "empty-home");
	await mkdir(home);
	const calls: string[] = [];
	const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(String(input));
		if (upstream) {
			return await upstream(input, init);
		}
		throw new Error("Unexpected fixture upstream call");
	}) as typeof fetch;
	const ai = new AiAccounts(root, { fetch: mockFetch, home });
	await ai.store.put({ ...CREDENTIAL });
	const aiInference = new AiInference({
		credential: (id: string, forceRefresh?: boolean) =>
			ai.credential(id, forceRefresh),
		fetch: mockFetch,
	});
	const instance = await startHub({
		ai,
		aiInference,
		catalogue: catalogueSchema.parse({ projects: [] }),
		port: 0,
		root,
		runtime: {
			dockerView: async () => ({ available: false, projects: [] }),
			listeningPorts: async () => new Map(),
			listeningPortsV6: async () => new Map(),
		},
	});
	const url = new URL(instance.url);
	const token = await clientToken(root);
	const browser = {
		"content-type": "application/json",
		origin: url.origin,
		"x-devhub": "1",
	};
	const machine = {
		"content-type": "application/json",
		"x-devhub-client": token,
	};
	return {
		ai,
		browser,
		calls,
		machine,
		request: (path: string, init?: RequestInit) =>
			fetch(new URL(path, url), init),
		root,
		stop: async () => {
			instance.stop();
			const absolute = resolve(root);
			if (
				dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
				!basename(absolute).startsWith("devhub-ai-api-test-")
			) {
				throw new Error("Refuse cleanup outside AI API fixture");
			}
			await rm(absolute, { force: true, recursive: true });
		},
	};
}

function containsCredentials(text: string): boolean {
	return [PRIVATE_ACCESS, PRIVATE_REFRESH, PRIVATE_ID].some((secret) =>
		text.includes(secret)
	);
}

test("AI state requires a local authenticated browser or machine request", async () => {
	const hub = await fixture();
	try {
		const denied = await Promise.all([
			hub.request("/api/ai/state"),
			hub.request("/api/ai/state", { headers: { origin: hub.browser.origin } }),
			hub.request("/api/ai/state", { headers: { "x-devhub": "1" } }),
			hub.request("/api/ai/state", {
				headers: { ...hub.browser, origin: "https://hostile.example" },
			}),
			hub.request("/api/ai/state", {
				headers: { ...hub.browser, host: "hostile.example" },
			}),
			hub.request("/api/ai/state", {
				headers: { ...hub.machine, origin: "https://hostile.example" },
			}),
			hub.request("/api/ai/state", {
				headers: { ...hub.machine, host: "hostile.example" },
			}),
		]);
		expect(denied.map((response) => response.status)).toEqual(
			new Array(7).fill(403)
		);
		const accepted = await Promise.all([
			hub.request("/api/ai/state", { headers: hub.browser }),
			hub.request("/api/ai/state", { headers: hub.machine }),
		]);
		expect(accepted.map((response) => response.status)).toEqual([200, 200]);
		const bodies = await Promise.all(
			accepted.map((response) => response.text())
		);
		expect(bodies.every((body) => !containsCredentials(body))).toBe(true);
		const state = JSON.parse(bodies[0] ?? "{}") as { accounts: unknown[] };
		expect(state.accounts).toHaveLength(1);
		expect(hub.calls).toEqual([]);
	} finally {
		await hub.stop();
	}
});

test("every AI mutation and native inference route rejects hostile requests before upstream work", async () => {
	const hub = await fixture();
	try {
		const paths = [
			"/api/ai/oauth/start",
			"/api/ai/oauth/fixture-flow/complete",
			"/api/ai/import",
			"/api/ai/accounts/fixture-codex/disconnect",
			"/api/ai/chat",
			"/v1/chat/completions",
			"/v1/responses",
			"/v1/messages",
		];
		const denied = await Promise.all(
			paths.flatMap((path) => [
				hub.request(path, { body: "{}", method: "POST" }),
				hub.request(path, {
					body: "{}",
					headers: { ...hub.browser, origin: "https://hostile.example" },
					method: "POST",
				}),
				hub.request(path, {
					body: "{}",
					headers: { ...hub.machine, host: "hostile.example" },
					method: "POST",
				}),
			])
		);
		expect(denied.map((response) => response.status)).toEqual(
			paths.flatMap((path) => [path.startsWith("/v1/") ? 401 : 403, 403, 403])
		);
		expect(await hub.ai.list()).toHaveLength(1);
		expect(hub.calls).toEqual([]);
	} finally {
		await hub.stop();
	}
});

test("AI JSON boundaries reject wrong content type, malformed JSON and oversized bodies", async () => {
	const hub = await fixture();
	try {
		const wrongType = await hub.request("/api/ai/import", {
			body: JSON.stringify({ provider: "codex" }),
			headers: { ...hub.browser, "content-type": "text/plain" },
			method: "POST",
		});
		expect(wrongType.status).toBe(415);
		const malformed = await hub.request("/api/ai/import", {
			body: "{",
			headers: hub.browser,
			method: "POST",
		});
		expect(malformed.status).toBe(400);
		const oversized = await hub.request("/api/ai/chat", {
			body: JSON.stringify({ prompt: "x".repeat(2_100_000) }),
			headers: hub.machine,
			method: "POST",
		});
		expect(oversized.status).toBe(413);
		expect(hub.calls).toEqual([]);
		expect(await hub.ai.list()).toHaveLength(1);
	} finally {
		await hub.stop();
	}
});

test("native model and inference APIs enforce machine authentication as well as browser origin", async () => {
	const hub = await fixture();
	try {
		const denied = await Promise.all([
			hub.request("/v1/models"),
			hub.request("/v1/models", {
				headers: { ...hub.browser, origin: "https://hostile.example" },
			}),
			hub.request("/v1/models", {
				headers: { ...hub.machine, host: "hostile.example" },
			}),
		]);
		expect(denied.map((response) => response.status)).toEqual([401, 403, 403]);
		const models = await hub.request("/v1/models", { headers: hub.machine });
		expect(models.status).toBe(200);
		expect(containsCredentials(await models.text())).toBe(false);
		const malformed = await Promise.all(
			["/v1/chat/completions", "/v1/responses", "/v1/messages"].map((path) =>
				hub.request(path, { body: "{", headers: hub.machine, method: "POST" })
			)
		);
		expect(malformed.every((response) => response.status === 400)).toBe(true);
		expect(hub.calls).toEqual([]);
	} finally {
		await hub.stop();
	}
});

test("provider response failures cannot expose access credentials or prompts through UI errors or logs", async () => {
	const hub = await fixture(
		async () =>
			new Response(
				JSON.stringify({
					error: {
						message: `${PRIVATE_ACCESS} ${PRIVATE_REFRESH} ${PRIVATE_ID} private prompt`,
					},
				}),
				{ headers: { "content-type": "application/json" }, status: 500 }
			)
	);
	try {
		const response = await hub.request("/api/ai/chat", {
			body: JSON.stringify({
				accountId: CREDENTIAL.id,
				messages: [{ content: "private prompt", role: "user" }],
				model: "fixture-model",
			}),
			headers: hub.browser,
			method: "POST",
		});
		const body = await response.text();
		expect(containsCredentials(body)).toBe(false);
		expect(body).not.toContain("private prompt");
		expect(body).toContain("error");
		const log = join(hub.root, ".logs", "actions.log");
		if (existsSync(log)) {
			const logged = await readFile(log, "utf8");
			expect(containsCredentials(logged)).toBe(false);
			expect(logged).not.toContain("private prompt");
		}
	} finally {
		await hub.stop();
	}
});

test("account models and disconnection retain local authorization and expose only public metadata", async () => {
	const hub = await fixture(async () =>
		Response.json({
			models: [{ display_name: "Fixture model", slug: "fixture-model" }],
		})
	);
	try {
		const path = `/api/ai/accounts/${CREDENTIAL.id}/models`;
		const denied = await Promise.all([
			hub.request(path),
			hub.request(path, {
				headers: { ...hub.browser, origin: "https://hostile.example" },
			}),
			hub.request(path, {
				headers: { ...hub.machine, host: "hostile.example" },
			}),
		]);
		expect(denied.every((response) => response.status === 403)).toBe(true);
		expect(hub.calls).toEqual([]);
		const models = await hub.request(path, { headers: hub.browser });
		expect(models.status).toBe(200);
		const body = await models.text();
		expect(body).toContain("fixture-model");
		expect(containsCredentials(body)).toBe(false);
		expect(hub.calls).toHaveLength(1);
		const disconnected = await hub.request(
			`/api/ai/accounts/${CREDENTIAL.id}/disconnect`,
			{
				body: "{}",
				headers: hub.machine,
				method: "POST",
			}
		);
		expect(disconnected.status).toBe(200);
		expect(await hub.ai.list()).toEqual([]);
	} finally {
		await hub.stop();
	}
});

test("OAuth flow status and manual completion require local authorization and matching state", async () => {
	const hub = await fixture();
	try {
		const started = await hub.request("/api/ai/oauth/start", {
			body: JSON.stringify({ provider: "claude" }),
			headers: hub.browser,
			method: "POST",
		});
		expect(started.status).toBe(200);
		const startBody = await started.text();
		expect(containsCredentials(startBody)).toBe(false);
		expect(startBody).not.toContain("codeVerifier");
		const flow = JSON.parse(startBody) as { id: string };
		const path = `/api/ai/oauth/${flow.id}`;
		const denied = await Promise.all([
			hub.request(path),
			hub.request(path, {
				headers: { ...hub.browser, origin: "https://hostile.example" },
			}),
			hub.request(path, {
				headers: { ...hub.machine, host: "hostile.example" },
			}),
		]);
		expect(denied.every((response) => response.status === 403)).toBe(true);
		const status = await hub.request(path, { headers: hub.browser });
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ status: "pending" });
		const mismatch = await hub.request(`${path}/complete`, {
			body: JSON.stringify({ code: "fixture-code#untrusted-state" }),
			headers: hub.browser,
			method: "POST",
		});
		expect(mismatch.status).toBe(400);
		expect(containsCredentials(await mismatch.text())).toBe(false);
		expect(hub.calls).toEqual([]);
	} finally {
		await hub.stop();
	}
});

test("browser GET without Origin accepts a same-origin Referer and rejects a hostile Referer", async () => {
	const hub = await fixture();
	try {
		const headers = {
			referer: `${hub.browser.origin}/`,
			"sec-fetch-site": "same-origin",
			"x-devhub": "1",
		};
		const accepted = await hub.request("/api/ai/state", { headers });
		expect(accepted.status).toBe(200);
		expect(containsCredentials(await accepted.text())).toBe(false);
		const denied = await hub.request("/api/ai/state", {
			headers: { ...headers, referer: "https://hostile.example/" },
		});
		expect(denied.status).toBe(403);
		expect(hub.calls).toEqual([]);
	} finally {
		await hub.stop();
	}
});

function proxyReply(text = "ok"): Response {
	return new Response(
		`data: ${JSON.stringify({ delta: text, type: "response.output_text.delta" })}\n\ndata: ${JSON.stringify({ response: { id: "resp-test", object: "response", output: [{ content: [{ text, type: "output_text" }], type: "message" }], usage: { input_tokens: 5, output_tokens: 2 } }, type: "response.completed" })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } }
	);
}

async function createProxyKey(
	hub: Awaited<ReturnType<typeof fixture>>,
	config: Record<string, unknown> = {}
): Promise<{ key: string; record: { id: string } }> {
	const response = await hub.request("/api/ai/proxy/keys", {
		body: JSON.stringify({ label: "Test client", ...config }),
		headers: hub.machine,
		method: "POST",
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<{ key: string; record: { id: string } }>;
}

test("SDK proxy keys authorize Bearer and x-api-key while preserving administrative and origin isolation", async () => {
	const hub = await fixture(async () => proxyReply());
	try {
		const created = await createProxyKey(hub);
		for (const headers of [
			new Headers({ authorization: `Bearer ${created.key}` }),
			new Headers({ "x-api-key": created.key }),
		]) {
			// biome-ignore lint/performance/noAwaitInLoops: Exercise independent SDK header conventions.
			const models = await hub.request("/v1/models", { headers });
			expect(models.status).toBe(200);
			const text = await models.text();
			expect(text).toContain("codex/");
			expect(containsCredentials(text)).toBe(false);
		}
		const headers = {
			authorization: `Bearer ${created.key}`,
			"content-type": "application/json",
		};
		const denied = await Promise.all([
			hub.request("/api/ai/state", { headers }),
			hub.request("/api/ai/accounts/fixture-codex/disconnect", {
				body: "{}",
				headers,
				method: "POST",
			}),
			hub.request("/v1/models", {
				headers: { ...headers, origin: "https://hostile.example" },
			}),
			hub.request("/v1/models", {
				headers: { ...headers, host: "hostile.example" },
			}),
		]);
		expect(denied.map((response) => response.status)).toEqual([
			403, 403, 403, 403,
		]);
		const reply = await hub.request("/v1/responses", {
			body: JSON.stringify({
				input: "hello",
				model: "codex/gpt-fixture",
				stream: false,
			}),
			headers,
			method: "POST",
		});
		expect(reply.status).toBe(200);
		expect(reply.headers.get("x-devhub-account")).toBe(CREDENTIAL.id);
		expect(await reply.json()).toMatchObject({ id: "resp-test" });
		const state = await hub.request("/api/ai/state", { headers: hub.machine });
		const text = await state.text();
		expect(text).not.toContain(created.key);
		expect(text).not.toContain("digest");
		expect(JSON.parse(text).proxy.stats).toMatchObject({
			completed: 1,
			inputTokens: 5,
			outputTokens: 2,
		});
		await hub.request(`/api/ai/proxy/keys/${created.record.id}/revoke`, {
			body: "{}",
			headers: hub.machine,
			method: "POST",
		});
		const revoked = await hub.request("/v1/models", { headers });
		expect(revoked.status).toBe(401);
		expect(revoked.headers.get("WWW-Authenticate")).toBe("Bearer");
	} finally {
		await hub.stop();
	}
});

test("automatic pool safely fails over after 429 and keeps account cooldown across models", async () => {
	const tokens: string[] = [];
	const hub = await fixture((_url, init) => {
		const token = new Headers(init?.headers).get("authorization") ?? "";
		tokens.push(token);
		return token === `Bearer ${PRIVATE_ACCESS}`
			? new Response("untrusted private error", {
					headers: { "retry-after": "7" },
					status: 429,
				})
			: proxyReply();
	});
	try {
		await hub.ai.store.put({
			...CREDENTIAL,
			accessToken: "second-test-token",
			id: `${CREDENTIAL.id}-b`,
			label: "Second",
		});
		const created = await createProxyKey(hub);
		const headers = {
			authorization: `Bearer ${created.key}`,
			"content-type": "application/json",
		};
		const call = (model: string) =>
			hub.request("/v1/responses", {
				body: JSON.stringify({ input: "hello", model, stream: false }),
				headers,
				method: "POST",
			});
		const reply = await call("codex/gpt-fixture");
		expect(reply.status).toBe(200);
		expect(reply.headers.get("x-devhub-account")).toBe(`${CREDENTIAL.id}-b`);
		await reply.text();
		expect(tokens).toEqual([
			`Bearer ${PRIVATE_ACCESS}`,
			"Bearer second-test-token",
		]);
		const another = await call("codex/gpt-other");
		await another.text();
		expect(tokens).toHaveLength(3);
		expect(tokens[2]).toBe("Bearer second-test-token");
		const pinned = await call(`${CREDENTIAL.id}/gpt-fixture`);
		expect(pinned.status).toBe(429);
		expect(Number(pinned.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(tokens).toHaveLength(3);
	} finally {
		await hub.stop();
	}
});

test("pool never retries unknown transport, server failure or a provider failure after HTTP200", async () => {
	const modes = ["transport", "server", "late"] as const;
	let mode: (typeof modes)[number] = "transport";
	let calls = 0;
	const hub = await fixture(() => {
		calls += 1;
		if (mode === "transport") {
			throw new Error("private prompt may have been accepted");
		}
		if (mode === "server") {
			return new Response("private error", { status: 503 });
		}
		return new Response(
			`data: ${JSON.stringify({ response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "private prompt" } }, type: "response.failed" })}\n\n`,
			{ headers: { "content-type": "text/event-stream" } }
		);
	});
	try {
		await hub.ai.store.put({
			...CREDENTIAL,
			accessToken: "second-test-token",
			id: `${CREDENTIAL.id}-b`,
			label: "Second",
		});
		for (const next of modes) {
			mode = next;
			const before = calls;
			// biome-ignore lint/performance/noAwaitInLoops: Observe precisely one upstream request for each failure class.
			const reply = await hub.request("/v1/responses", {
				body: JSON.stringify({
					input: "private prompt",
					model: "codex/gpt-fixture",
					stream: next === "late",
				}),
				headers: hub.machine,
				method: "POST",
			});
			const text = await reply.text();
			expect(text).not.toContain("private prompt");
			expect(calls - before).toBe(1);
		}
	} finally {
		await hub.stop();
	}
});

test("key scopes, aliases and rate limits are enforced at the proxy boundary", async () => {
	const hub = await fixture(async () => proxyReply());
	try {
		const config = await hub.request("/api/ai/proxy/config", {
			body: JSON.stringify({
				aliases: [{ id: "coding", model: "gpt-fixture", provider: "codex" }],
				strategy: "least-busy",
			}),
			headers: hub.machine,
			method: "POST",
		});
		expect(config.status).toBe(200);
		const key = await createProxyKey(hub, {
			allowedAccounts: [CREDENTIAL.id],
			allowedModels: ["coding"],
			allowedProviders: ["codex"],
		});
		const headers = {
			authorization: `Bearer ${key.key}`,
			"content-type": "application/json",
		};
		const models = await hub.request("/v1/models", { headers });
		expect(
			(await models.json()).data.map((model: { id: string }) => model.id)
		).toEqual(["coding"]);
		const denied = await hub.request("/v1/responses", {
			body: JSON.stringify({ input: "hello", model: "codex/gpt-other" }),
			headers,
			method: "POST",
		});
		expect(denied.status).toBe(403);
		expect(hub.calls).toHaveLength(0);
		const accepted = await hub.request("/v1/responses", {
			body: JSON.stringify({ input: "hello", model: "coding", stream: false }),
			headers,
			method: "POST",
		});
		expect(accepted.status).toBe(200);
		await accepted.text();
		const limited = await createProxyKey(hub, { requestsPerMinute: 1 });
		const rateHeaders = { "x-api-key": limited.key };
		expect(
			(await hub.request("/v1/models", { headers: rateHeaders })).status
		).toBe(200);
		const throttled = await hub.request("/v1/models", { headers: rateHeaders });
		expect(throttled.status).toBe(429);
		expect(throttled.headers.has("Retry-After")).toBe(true);
	} finally {
		await hub.stop();
	}
});

test("nonstream SIWC usage-unavailable terminal applies cooldown without replay", async () => {
	let calls = 0;
	const hub = await fixture(() => {
		calls += 1;
		return new Response(
			`data: ${JSON.stringify({ response: { error: { code: "subscription_sharing_usage_unavailable" } }, type: "response.failed" })}\n\n`,
			{ headers: { "content-type": "text/event-stream" } }
		);
	});
	try {
		const failed = await hub.request("/v1/responses", {
			body: JSON.stringify({
				input: "hello",
				model: "codex/gpt-fixture",
				stream: false,
			}),
			headers: hub.machine,
			method: "POST",
		});
		expect(failed.status).toBe(503);
		expect(calls).toBe(1);
		const state = await hub.request("/api/ai/state", { headers: hub.machine });
		expect((await state.json()).accounts[0].pool.status).toBe("cooldown");
		const cooled = await hub.request("/v1/responses", {
			body: JSON.stringify({
				input: "hello",
				model: "codex/gpt-other",
				stream: false,
			}),
			headers: hub.machine,
			method: "POST",
		});
		expect(cooled.status).toBe(429);
		expect(calls).toBe(1);
	} finally {
		await hub.stop();
	}
});
