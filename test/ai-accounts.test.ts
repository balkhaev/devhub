import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { AiAccounts } from "../src/ai/accounts";
import { AiStore } from "../src/ai/store";
import type { AiCredential } from "../src/ai/types";

const NOW = Date.UTC(2026, 9, 3, 10);
const OPENAI_CLIENT = "oaiapp_devhub_fixture";
const OPENAI_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
const OPENAI_JWKS = "https://auth.openai.com/.well-known/jwks.json";
const CLAUDE_TOKEN = "https://api.anthropic.com/v1/oauth/token";
const DIRECT_SCOPES =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PRIVATE_ACCESS = "fixture-private-access";
const PRIVATE_REFRESH = "fixture-private-refresh";
const PRIVATE_ID = "fixture-private-id";
const CREDENTIAL: AiCredential = {
	accessToken: PRIVATE_ACCESS,
	authMode: "claude",
	clientId: "claude-fixture-client",
	expiresAt: NOW - 1,
	id: "fixture-oauth",
	idToken: PRIVATE_ID,
	label: "Fixture account",
	provider: "claude",
	refreshToken: PRIVATE_REFRESH,
	source: "oauth",
};

interface Call {
	body: string;
	headers: Headers;
	url: string;
}
type Upstream = (call: Call) => Promise<Response> | Response;

function required<T>(value: T | undefined): T {
	if (value === undefined) {
		throw new Error("Missing fixture result");
	}
	return value;
}

function deferred<T>() {
	let resolveValue!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((accept) => {
		resolveValue = accept;
	});
	return { promise, resolve: resolveValue };
}

async function fixture(upstream?: Upstream) {
	const root = await mkdtemp(join(tmpdir(), "devhub-ai-accounts-test-"));
	const home = join(root, "fixture-home");
	await mkdir(home);
	const clock = { at: NOW };
	const calls: Call[] = [];
	const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = {
			body: String(init?.body ?? ""),
			headers: new Headers(init?.headers),
			url: input instanceof Request ? input.url : String(input),
		};
		calls.push(call);
		if (upstream) {
			return await upstream(call);
		}
		throw new Error("Unexpected upstream request in account fixture");
	}) as typeof fetch;
	const ai = new AiAccounts(root, {
		fetch: mockFetch,
		home,
		now: () => clock.at,
	});
	return {
		ai,
		calls,
		cleanup: async () => {
			ai.stop();
			const absolute = resolve(root);
			if (
				dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
				!basename(absolute).startsWith("devhub-ai-accounts-test-")
			) {
				throw new Error("Refuse cleanup outside AI account fixture");
			}
			await rm(absolute, { force: true, recursive: true });
		},
		clock,
		home,
		root,
	};
}

const signingKeys = Promise.all([
	generateKeyPair("RS256", { extractable: true }),
	generateKeyPair("RS256", { extractable: true }),
]);

async function openaiFixture(
	options: {
		audience?: string;
		expiresAt?: number;
		issuer?: string;
		nonce?: string;
		scope?: string;
		signedByOtherKey?: boolean;
		subject?: string;
	} = {}
) {
	const [trusted, other] = await signingKeys;
	const publicKey = await exportJWK(trusted.publicKey);
	let nonce = "";
	const account = await fixture(async (call) => {
		if (call.url === OPENAI_JWKS) {
			return Response.json({
				keys: [{ ...publicKey, alg: "RS256", kid: "fixture-key", use: "sig" }],
			});
		}
		if (call.url === OPENAI_TOKEN) {
			const token = await new SignJWT({
				email: "fixture@example.test",
				nonce: options.nonce ?? nonce,
			})
				.setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
				.setIssuer(options.issuer ?? "https://auth.openai.com")
				.setAudience(options.audience ?? OPENAI_CLIENT)
				.setSubject(options.subject ?? "fixture-subject")
				.setIssuedAt(NOW / 1000)
				.setExpirationTime(options.expiresAt ?? NOW / 1000 + 3600)
				.sign(options.signedByOtherKey ? other.privateKey : trusted.privateKey);
			return Response.json({
				access_token: PRIVATE_ACCESS,
				expires_in: 3600,
				id_token: token,
				refresh_token: PRIVATE_REFRESH,
				scope: options.scope ?? DIRECT_SCOPES,
			});
		}
		throw new Error("Unexpected OpenAI fixture endpoint");
	});
	return {
		...account,
		begin: async (accountId?: string) => {
			const flow = await account.ai.startOAuth(
				"codex",
				"http://127.0.0.1:4700",
				accountId
			);
			const url = new URL(flow.url);
			nonce = url.searchParams.get("nonce") ?? "";
			return { flow, url };
		},
	};
}

function callback(state: string, clientId = OPENAI_CLIENT) {
	const url = new URL("http://127.0.0.1:4700/auth/callback");
	url.search = new URLSearchParams({
		client_id: clientId,
		code: "fixture-code",
		state,
	}).toString();
	return url;
}

function unsignedJwt(payload: Record<string, unknown>) {
	return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
}

test("AI vault encrypts credentials and reloads an unchanged persistent host identity", async () => {
	const account = await fixture();
	try {
		await account.ai.store.put(CREDENTIAL);
		const hostId = await account.ai.store.hostId();
		const encrypted = await readFile(
			join(account.root, ".state", "ai", "accounts.enc")
		);
		const key = await readFile(join(account.root, ".state", "ai", "vault.key"));
		expect(key.length).toBe(32);
		expect(encrypted.includes(Buffer.from(PRIVATE_ACCESS))).toBe(false);
		expect(encrypted.includes(Buffer.from(PRIVATE_REFRESH))).toBe(false);
		expect(encrypted.includes(Buffer.from(PRIVATE_ID))).toBe(false);
		const reloaded = new AiStore(account.root);
		expect(await reloaded.get(CREDENTIAL.id)).toEqual(CREDENTIAL);
		expect(await reloaded.hostId()).toBe(hostId);
		expect(JSON.stringify(await account.ai.list())).not.toContain(
			PRIVATE_ACCESS
		);
		expect(await readdir(join(account.root, ".state", "ai"))).toEqual([
			"accounts.enc",
			"vault.key",
		]);
	} finally {
		await account.cleanup();
	}
});

test.each(["ciphertext", "key"] as const)(
	"%s corruption fails closed without replacing saved bytes",
	async (mode) => {
		const account = await fixture();
		try {
			await account.ai.store.put(CREDENTIAL);
			const vaultPath = join(account.root, ".state", "ai", "accounts.enc");
			const keyPath = join(account.root, ".state", "ai", "vault.key");
			const key = await readFile(keyPath);
			const original = await readFile(vaultPath);
			const damaged = Buffer.from(original);
			if (mode === "ciphertext") {
				damaged[0] = ((damaged[0] ?? 0) + 1) % 256;
				await writeFile(vaultPath, damaged);
			} else {
				await rm(keyPath);
			}
			const saved = await readFile(vaultPath);
			const reloaded = new AiStore(account.root);
			await expect(reloaded.list()).rejects.toMatchObject({ status: 500 });
			await expect(
				reloaded.put({ ...CREDENTIAL, id: "another" })
			).rejects.toMatchObject({ status: 500 });
			expect(await readFile(vaultPath)).toEqual(saved);
			if (mode === "ciphertext") {
				expect(await readFile(keyPath)).toEqual(key);
			} else {
				expect(existsSync(keyPath)).toBe(false);
			}
			expect(await readdir(join(account.root, ".state", "ai"))).not.toContain(
				"accounts.enc.tmp"
			);
		} finally {
			await account.cleanup();
		}
	}
);

test("Claude OAuth binds state and PKCE to one attempt and consumes a successful code once", async () => {
	const account = await fixture(() =>
		Response.json({
			access_token: PRIVATE_ACCESS,
			account: {
				email_address: "fixture@example.test",
				uuid: "fixture-claude",
			},
			expires_in: 3600,
			refresh_token: PRIVATE_REFRESH,
		})
	);
	try {
		const flow = await account.ai.startOAuth("claude", "http://127.0.0.1:4700");
		const other = await account.ai.startOAuth(
			"claude",
			"http://127.0.0.1:4700"
		);
		const url = new URL(flow.url);
		const state = url.searchParams.get("state") ?? "";
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.has("code_verifier")).toBe(false);
		expect(new URL(other.url).searchParams.get("state")).not.toBe(state);
		expect(new URL(other.url).searchParams.get("code_challenge")).not.toBe(
			url.searchParams.get("code_challenge")
		);
		await expect(
			account.ai.completeOAuth(flow.id, "fixture-code#wrong-state")
		).rejects.toMatchObject({ status: 400 });
		expect(account.calls).toHaveLength(0);
		await account.ai.completeOAuth(flow.id, `fixture-code#${state}`);
		expect(account.calls).toHaveLength(1);
		const exchange = required(account.calls.at(0));
		expect(exchange.url).toBe(CLAUDE_TOKEN);
		const payload = JSON.parse(exchange.body);
		expect(payload.state).toBe(state);
		expect(payload.redirect_uri).toBe(
			"https://platform.claude.com/oauth/code/callback"
		);
		expect(
			createHash("sha256").update(payload.code_verifier).digest("base64url")
		).toBe(url.searchParams.get("code_challenge") ?? "");
		expect(account.ai.oauthStatus(flow.id)).toEqual({ status: "complete" });
		await expect(
			account.ai.completeOAuth(flow.id, `fixture-code#${state}`)
		).rejects.toMatchObject({ status: 400 });
		expect(account.calls).toHaveLength(1);
		expect((await account.ai.store.list())[0]).toMatchObject({
			accessToken: PRIVATE_ACCESS,
			authMode: "claude",
			refreshToken: PRIVATE_REFRESH,
			source: "oauth",
		});
	} finally {
		await account.cleanup();
	}
});

test("expired OAuth attempts reject code exchange before contacting a provider", async () => {
	const account = await fixture();
	try {
		const flow = await account.ai.startOAuth("claude", "http://127.0.0.1:4700");
		const state = new URL(flow.url).searchParams.get("state") ?? "";
		account.clock.at = flow.expiresAt + 1;
		expect(account.ai.oauthStatus(flow.id)).toEqual({ status: "expired" });
		await expect(
			account.ai.completeOAuth(flow.id, `fixture-code#${state}`)
		).rejects.toMatchObject({ status: 400 });
		expect(account.calls).toHaveLength(0);
		expect(await account.ai.list()).toEqual([]);
	} finally {
		await account.cleanup();
	}
});

test("SIWC registers a local dynamic client and verifies the signed ID token before saving", async () => {
	const account = await openaiFixture();
	try {
		const { flow, url } = await account.begin();
		const state = url.searchParams.get("state") ?? "";
		expect(url.origin + url.pathname).toBe(
			"https://auth.openai.com/api/accounts/authorize"
		);
		expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(url.searchParams.get("scope")).toBe(DIRECT_SCOPES);
		expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"http://127.0.0.1:4700/auth/callback"
		);
		expect(url.searchParams.get("ext_agent_host_id")).toBe(
			await account.ai.store.hostId()
		);
		await expect(
			account.ai.callback(callback("other-state"))
		).rejects.toMatchObject({ status: 400 });
		await expect(
			account.ai.completeOAuth(flow.id, "fixture-code", state)
		).rejects.toMatchObject({ status: 401 });
		await expect(
			account.ai.callback(callback(state, "dynamic_agent_client"))
		).rejects.toMatchObject({ status: 401 });
		await expect(
			account.ai.callback(callback(state, "other-client"))
		).rejects.toMatchObject({ status: 401 });
		expect(account.calls).toHaveLength(0);
		await account.ai.callback(callback(state));
		const [firstSaved] = await account.ai.store.list();
		const saved = required(firstSaved);
		expect(saved).toMatchObject({
			authMode: "siwc",
			clientId: OPENAI_CLIENT,
			email: "fixture@example.test",
			source: "oauth",
			subject: "fixture-subject",
		});
		expect(saved.scopes).toContain("chatgpt.tokens.use.direct");
		expect(account.calls.map((call) => call.url)).toEqual([
			OPENAI_TOKEN,
			OPENAI_JWKS,
		]);
		const payload = new URLSearchParams(required(account.calls.at(0)).body);
		expect(payload.get("client_id")).toBe(OPENAI_CLIENT);
		expect(payload.get("resource")).toBe("https://api.openai.com/v1");
		expect(
			createHash("sha256")
				.update(payload.get("code_verifier") ?? "")
				.digest("base64url")
		).toBe(url.searchParams.get("code_challenge") ?? "");
		await expect(account.ai.callback(callback(state))).rejects.toMatchObject({
			status: 400,
		});
	} finally {
		await account.cleanup();
	}
});

test.each([
	{ signedByOtherKey: true },
	{ nonce: "foreign-nonce" },
	{ audience: "oaiapp_foreign_client" },
	{ issuer: "https://foreign.example" },
	{ expiresAt: NOW / 1000 - 60 },
	{ scope: "openid profile email offline_access resource.invoke" },
])(
	"SIWC rejects invalid identity or missing plan scope: %j",
	async (options) => {
		const account = await openaiFixture(options);
		try {
			const { flow, url } = await account.begin();
			await expect(
				account.ai.callback(callback(url.searchParams.get("state") ?? ""))
			).rejects.toBeInstanceOf(Error);
			expect(account.ai.oauthStatus(flow.id).status).toBe("error");
			expect(await account.ai.store.list()).toEqual([]);
			const publicStatus = JSON.stringify(account.ai.oauthStatus(flow.id));
			expect(publicStatus).not.toContain(PRIVATE_ACCESS);
			expect(publicStatus).not.toContain(PRIVATE_REFRESH);
			await expect(
				account.ai.callback(callback(url.searchParams.get("state") ?? ""))
			).rejects.toMatchObject({ status: 400 });
		} finally {
			await account.cleanup();
		}
	}
);

test("SIWC reauthentication binds the registered client and account subject", async () => {
	const account = await openaiFixture({ subject: "foreign-subject" });
	try {
		await account.ai.store.put({
			...CREDENTIAL,
			authMode: "siwc",
			clientId: OPENAI_CLIENT,
			provider: "codex",
			scopes: DIRECT_SCOPES.split(" "),
			subject: "fixture-subject",
		});
		const { flow, url } = await account.begin(CREDENTIAL.id);
		expect(url.searchParams.get("client_id")).toBe(OPENAI_CLIENT);
		await expect(
			account.ai.callback(
				callback(url.searchParams.get("state") ?? "", "oaiapp_other")
			)
		).rejects.toMatchObject({ status: 401 });
		expect(account.calls).toHaveLength(0);
		await expect(
			account.ai.completeOAuth(
				flow.id,
				"fixture-code",
				url.searchParams.get("state") ?? "",
				OPENAI_CLIENT
			)
		).rejects.toMatchObject({ status: 401 });
		expect((await account.ai.store.get(CREDENTIAL.id)).accessToken).toBe(
			PRIVATE_ACCESS
		);
		expect((await account.ai.store.get(CREDENTIAL.id)).subject).toBe(
			"fixture-subject"
		);
	} finally {
		await account.cleanup();
	}
});

test("simultaneous refreshes share one request and await durable rotated credentials", async () => {
	const requested = deferred<Call>();
	const response = deferred<Response>();
	const account = await fixture((call) => {
		requested.resolve(call);
		return response.promise;
	});
	try {
		await account.ai.store.put(CREDENTIAL);
		const waiting = Array.from({ length: 12 }, () =>
			account.ai.credential(CREDENTIAL.id)
		);
		const call = await requested.promise;
		const params = new URLSearchParams(call.body);
		expect(params.get("refresh_token")).toBe(PRIVATE_REFRESH);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.has("scope")).toBe(false);
		expect(call.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		response.resolve(
			Response.json({
				access_token: "rotated-access",
				expires_in: 3600,
				refresh_token: "rotated-refresh",
			})
		);
		const results = await Promise.all(waiting);
		expect(account.calls).toHaveLength(1);
		expect(
			results.every(
				(credential) =>
					credential.accessToken === "rotated-access" &&
					credential.refreshToken === "rotated-refresh"
			)
		).toBe(true);
		expect(await new AiStore(account.root).get(CREDENTIAL.id)).toMatchObject({
			accessToken: "rotated-access",
			expiresAt: NOW + 3_600_000,
			refreshToken: "rotated-refresh",
		});
		expect((await account.ai.credential(CREDENTIAL.id)).accessToken).toBe(
			"rotated-access"
		);
		expect(account.calls).toHaveLength(1);
	} finally {
		response.resolve(Response.json({ access_token: "cleanup-access" }));
		await account.cleanup();
	}
});

test("disconnect during refresh prevents rotated credentials from resurrecting an account", async () => {
	const requested = deferred<void>();
	const response = deferred<Response>();
	const account = await fixture(() => {
		requested.resolve();
		return response.promise;
	});
	try {
		await account.ai.store.put(CREDENTIAL);
		const refreshing = account.ai
			.credential(CREDENTIAL.id)
			.catch((error: unknown) => error);
		await requested.promise;
		const disconnecting = account.ai.disconnect(CREDENTIAL.id);
		response.resolve(
			Response.json({
				access_token: "rotated-after-disconnect",
				expires_in: 3600,
				refresh_token: "new-refresh",
			})
		);
		await disconnecting;
		expect(await refreshing).toMatchObject({ status: 401 });
		expect(await new AiStore(account.root).list()).toEqual([]);
		await expect(account.ai.credential(CREDENTIAL.id)).rejects.toMatchObject({
			status: 401,
		});
		expect(account.calls).toHaveLength(1);
	} finally {
		response.resolve(Response.json({ access_token: "cleanup-access" }));
		await account.cleanup();
	}
});

test.each(["401", "scope"] as const)(
	"refresh revoked by %s expires accounts and stops retries",
	async (revokedBy) => {
		const account = await fixture(() =>
			revokedBy === "401"
				? Response.json({ error: PRIVATE_REFRESH }, { status: 401 })
				: Response.json({
						access_token: "new-access",
						expires_in: 3600,
						refresh_token: "new-refresh",
						scope: "openid resource.invoke",
					})
		);
		try {
			const credential =
				revokedBy === "scope"
					? {
							...CREDENTIAL,
							authMode: "siwc" as const,
							clientId: OPENAI_CLIENT,
							provider: "codex" as const,
							scopes: DIRECT_SCOPES.split(" "),
						}
					: CREDENTIAL;
			await account.ai.store.put(credential);
			await expect(account.ai.credential(credential.id)).rejects.toMatchObject({
				status: revokedBy === "401" ? 401 : 403,
			});
			const stored = await new AiStore(account.root).get(credential.id);
			expect(stored.refreshToken).toBeUndefined();
			expect(stored.expiresAt).toBeLessThan(NOW);
			expect((await account.ai.list()).at(0)?.status).toBe("expired");
			await expect(account.ai.credential(credential.id)).rejects.toMatchObject({
				status: 401,
			});
			expect(account.calls).toHaveLength(1);
		} finally {
			await account.cleanup();
		}
	}
);

test("temporary refresh failures preserve retryable credentials and hide provider bodies", async () => {
	const account = await fixture(() =>
		Response.json(
			{ access_token: PRIVATE_ACCESS, error: PRIVATE_REFRESH },
			{ status: 503 }
		)
	);
	try {
		await account.ai.store.put(CREDENTIAL);
		let error: unknown;
		try {
			await account.ai.credential(CREDENTIAL.id);
		} catch (failure) {
			error = failure;
		}
		expect(error).toMatchObject({ status: 502 });
		expect(String(error)).not.toContain(PRIVATE_REFRESH);
		expect(String(error)).not.toContain(PRIVATE_ACCESS);
		expect(await new AiStore(account.root).get(CREDENTIAL.id)).toEqual(
			CREDENTIAL
		);
	} finally {
		await account.cleanup();
	}
});

test("CLI imports retain only access snapshots and never rotate or modify CLI credentials", async () => {
	const account = await fixture();
	try {
		const codexPath = join(account.home, ".codex", "auth.json");
		const claudePath = join(account.home, ".claude", ".credentials.json");
		await mkdir(dirname(codexPath));
		await mkdir(dirname(claudePath));
		const access = unsignedJwt({
			exp: NOW / 1000 + 7200,
			"https://api.openai.com/auth": {
				chatgpt_account_id: "fixture-workspace",
				chatgpt_user_id: "fixture-user",
			},
			sub: "fixture-user",
		});
		const codex = JSON.stringify({
			tokens: {
				access_token: access,
				id_token: unsignedJwt({
					email: "fixture@example.test",
					exp: NOW / 1000 - 3600,
				}),
				refresh_token: PRIVATE_REFRESH,
			},
		});
		const claude = JSON.stringify({
			claudeAiOauth: {
				accessToken: PRIVATE_ACCESS,
				expiresAt: NOW + 7_200_000,
				refreshToken: PRIVATE_REFRESH,
				scopes: ["user:inference"],
			},
		});
		await writeFile(codexPath, codex);
		await writeFile(claudePath, claude);
		await account.ai.import("codex");
		await account.ai.import("claude");
		const saved = await account.ai.store.list();
		expect(saved).toHaveLength(2);
		const importedCodex = saved.find((entry) => entry.provider === "codex");
		expect(importedCodex).toMatchObject({
			accountId: "fixture-workspace",
			authMode: "codex",
			expiresAt: NOW + 7_200_000,
			source: "codex-cli",
			subject: "fixture-user",
		});
		expect(
			saved.every(
				(entry) =>
					entry.refreshToken === undefined && entry.idToken === undefined
			)
		).toBe(true);
		expect(await readFile(codexPath, "utf8")).toBe(codex);
		expect(await readFile(claudePath, "utf8")).toBe(claude);
		await Promise.all(
			saved.map(async (entry) => {
				expect((await account.ai.credential(entry.id)).accessToken).toBe(
					entry.accessToken
				);
				await expect(
					account.ai.credential(entry.id, true)
				).rejects.toMatchObject({ status: 401 });
			})
		);
		await Promise.all(saved.map((entry) => account.ai.disconnect(entry.id)));
		expect(await account.ai.list()).toEqual([]);
		await account.ai.import("codex");
		await account.ai.import("claude");
		await Promise.all(
			saved.map(async (entry) => {
				expect((await account.ai.credential(entry.id)).accessToken).toBe(
					entry.accessToken
				);
			})
		);
		account.clock.at += 7_200_001;
		await Promise.all(
			saved.map(async (entry) => {
				await expect(account.ai.credential(entry.id)).rejects.toMatchObject({
					status: 401,
				});
			})
		);
		expect(account.calls).toHaveLength(0);
		expect(await readFile(codexPath, "utf8")).toBe(codex);
		expect(await readFile(claudePath, "utf8")).toBe(claude);
	} finally {
		await account.cleanup();
	}
});

test("expired access tokens with an owned refresh token stay connected until refresh is revoked", async () => {
	const account = await fixture();
	try {
		await account.ai.store.put(CREDENTIAL);
		await account.ai.store.put({
			...CREDENTIAL,
			id: "fixture-cli",
			refreshToken: undefined,
			source: "claude-cli",
		});
		const views = await account.ai.list();
		expect(views.find((entry) => entry.id === CREDENTIAL.id)?.status).toBe(
			"connected"
		);
		expect(views.find((entry) => entry.id === "fixture-cli")?.status).toBe(
			"expired"
		);
		expect(account.calls).toHaveLength(0);
	} finally {
		await account.cleanup();
	}
});

test("several Claude CLI access snapshots are retained and repeated import is idempotent", async () => {
	const account = await fixture();
	try {
		const path = join(account.home, ".claude", ".credentials.json");
		await mkdir(dirname(path));
		const first = JSON.stringify({
			claudeAiOauth: {
				accessToken: "first-test-snapshot",
				expiresAt: NOW + 7_200_000,
			},
		});
		const second = JSON.stringify({
			claudeAiOauth: {
				accessToken: "second-test-snapshot",
				expiresAt: NOW + 7_200_000,
			},
		});
		await writeFile(path, first);
		await account.ai.import("claude");
		await account.ai.import("claude");
		expect(await account.ai.list()).toHaveLength(1);
		await writeFile(path, second);
		await account.ai.import("claude");
		expect(await account.ai.list()).toHaveLength(2);
		expect(
			(await account.ai.store.list()).map((entry) => entry.accessToken).sort()
		).toEqual(["first-test-snapshot", "second-test-snapshot"]);
		expect(await readFile(path, "utf8")).toBe(second);
		expect(account.calls).toHaveLength(0);
	} finally {
		await account.cleanup();
	}
});

test("changing pool settings while OAuth refresh is pending cannot re-enable an account", async () => {
	const requested = deferred<void>();
	const response = deferred<Response>();
	const account = await fixture(() => {
		requested.resolve();
		return response.promise;
	});
	try {
		await account.ai.store.put({
			...CREDENTIAL,
			enabled: true,
			maxConcurrency: 4,
			priority: 0,
			weight: 1,
		});
		const refresh = account.ai.credential(CREDENTIAL.id);
		await requested.promise;
		await account.ai.store.configureAccount(CREDENTIAL.id, {
			enabled: false,
			label: "Paused",
			maxConcurrency: 1,
			priority: 10,
			weight: 3,
		});
		response.resolve(
			Response.json({
				access_token: "refreshed-test-only",
				expires_in: 3600,
				refresh_token: "rotated-test-only",
			})
		);
		await refresh;
		expect(await new AiStore(account.root).get(CREDENTIAL.id)).toMatchObject({
			accessToken: "refreshed-test-only",
			enabled: false,
			label: "Paused",
			maxConcurrency: 1,
			priority: 10,
			weight: 3,
		});
	} finally {
		response.resolve(Response.json({ access_token: "cleanup-test-only" }));
		await account.cleanup();
	}
});

test("fresh sign-in survives an older refresh success and an older refresh rejection", async () => {
	for (const status of [200, 401]) {
		const requested = deferred<void>();
		const response = deferred<Response>();
		// biome-ignore lint/performance/noAwaitInLoops: Verify independent delayed refresh outcomes with isolated vaults.
		const account = await fixture(() => {
			requested.resolve();
			return response.promise;
		});
		try {
			await account.ai.store.put(CREDENTIAL);
			const refreshing = account.ai.credential(CREDENTIAL.id);
			await requested.promise;
			await account.ai.store.put({
				...CREDENTIAL,
				accessToken: "new-signin-test-access",
				clientId: "new-signin-client",
				expiresAt: NOW + 7_200_000,
				refreshToken: "new-signin-test-refresh",
			});
			response.resolve(
				status === 200
					? Response.json({
							access_token: "old-refresh-test-access",
							refresh_token: "old-refresh-test-token",
						})
					: new Response("revoked old grant", { status })
			);
			expect(await refreshing).toMatchObject({
				accessToken: "new-signin-test-access",
				clientId: "new-signin-client",
				refreshToken: "new-signin-test-refresh",
			});
			expect(await new AiStore(account.root).get(CREDENTIAL.id)).toMatchObject({
				accessToken: "new-signin-test-access",
				expiresAt: NOW + 7_200_000,
				refreshToken: "new-signin-test-refresh",
			});
		} finally {
			response.resolve(Response.json({ access_token: "cleanup-test-access" }));
			await account.cleanup();
		}
	}
});

test("reconnecting the same verified ChatGPT subject updates its existing subscription", async () => {
	const account = await openaiFixture();
	try {
		await account.ai.store.put({
			...CREDENTIAL,
			authMode: "siwc",
			clientId: "previous-client",
			enabled: false,
			id: "previous-subscription",
			label: "My account",
			provider: "codex",
			subject: "fixture-subject",
		});
		const { url } = await account.begin();
		await account.ai.callback(callback(url.searchParams.get("state") ?? ""));
		expect(await account.ai.list()).toHaveLength(1);
		expect(await account.ai.store.get("previous-subscription")).toMatchObject({
			accessToken: PRIVATE_ACCESS,
			clientId: OPENAI_CLIENT,
			enabled: false,
			label: "My account",
			subject: "fixture-subject",
		});
	} finally {
		await account.cleanup();
	}
});

test("a newer completed sign-in survives a disconnect waiting for an older refresh", async () => {
	const requested = deferred<void>();
	const response = deferred<Response>();
	const account = await fixture((call) => {
		if (new URLSearchParams(call.body).get("grant_type") === "refresh_token") {
			requested.resolve();
			return response.promise;
		}
		return Response.json({
			access_token: "fresh-login-test-only",
			account: { uuid: "shared-fixture-subject" },
			expires_in: 3600,
			refresh_token: "fresh-login-refresh-test",
		});
	});
	try {
		await account.ai.store.put({
			...CREDENTIAL,
			subject: "shared-fixture-subject",
		});
		const refreshing = account.ai
			.credential(CREDENTIAL.id)
			.catch((error: unknown) => error);
		await requested.promise;
		const disconnecting = account.ai.disconnect(CREDENTIAL.id);
		const flow = await account.ai.startOAuth("claude", "http://127.0.0.1:4700");
		const state = new URL(flow.url).searchParams.get("state") ?? "";
		await account.ai.completeOAuth(flow.id, `test-code#${state}`);
		response.resolve(Response.json({ access_token: "old-refresh-test-only" }));
		await Promise.all([refreshing, disconnecting]);
		expect(await account.ai.store.get(CREDENTIAL.id)).toMatchObject({
			accessToken: "fresh-login-test-only",
			refreshToken: "fresh-login-refresh-test",
		});
		expect((await account.ai.credential(CREDENTIAL.id)).accessToken).toBe(
			"fresh-login-test-only"
		);
	} finally {
		response.resolve(Response.json({ access_token: "cleanup-test-only" }));
		await account.cleanup();
	}
});

test("stopping the hub cancels pending OAuth persistence even after token exchange started", async () => {
	const requested = deferred<void>();
	const response = deferred<Response>();
	const account = await fixture(() => {
		requested.resolve();
		return response.promise;
	});
	try {
		const flow = await account.ai.startOAuth("claude", "http://127.0.0.1:4700");
		const state = new URL(flow.url).searchParams.get("state") ?? "";
		const completing = account.ai
			.completeOAuth(flow.id, `fixture-code#${state}`)
			.catch((error: unknown) => error);
		await requested.promise;
		account.ai.stop();
		response.resolve(
			Response.json({
				access_token: PRIVATE_ACCESS,
				expires_in: 3600,
				refresh_token: PRIVATE_REFRESH,
			})
		);
		expect(await completing).toMatchObject({ status: 400 });
		expect(await account.ai.store.list()).toEqual([]);
	} finally {
		response.resolve(Response.json({ access_token: "cleanup-access" }));
		await account.cleanup();
	}
});
