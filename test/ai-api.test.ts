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
) => Promise<Response>;

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
		expect(denied.every((response) => response.status === 403)).toBe(true);
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
		expect(denied.map((response) => response.status)).toEqual([403, 403, 403]);
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
