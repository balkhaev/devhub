import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AiAccounts } from "../src/ai/accounts";
import { AiProxyKeys } from "../src/ai/keys";
import { AiPool } from "../src/ai/pool";
import { AiStore } from "../src/ai/store";
import type { AiCredential } from "../src/ai/types";

const roots: string[] = [];
const ACCOUNT: AiCredential = {
	accessToken: "test-only-access",
	authMode: "codex",
	clientId: "test-client",
	id: "a",
	label: "A",
	provider: "codex",
	source: "token",
};
const SIGNAL = new AbortController().signal;
const PROXY_SECRET = /^dh_[a-zA-Z0-9_-]{43}$/;

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "devhub-ai-pool-test-"));
	roots.push(root);
	const store = new AiStore(root);
	await store.put({ ...ACCOUNT });
	await store.put({
		...ACCOUNT,
		accessToken: "test-only-b",
		id: "b",
		label: "B",
	});
	let now = 100_000;
	return {
		keys: new AiProxyKeys(store, () => now),
		pool: new AiPool(store, () => now),
		root,
		store,
		time: (value: number) => {
			now = value;
		},
	};
}

afterAll(async () => {
	await Promise.all(
		roots.map(async (root) => {
			const absolute = resolve(root);
			if (
				dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
				!basename(absolute).startsWith("devhub-ai-pool-test-")
			) {
				throw new Error("Refuse cleanup outside pool fixture");
			}
			await rm(absolute, { force: true, recursive: true });
		})
	);
});

test("weighted round robin fairly uses several subscriptions and counts terminal usage once", async () => {
	const { pool, store } = await fixture();
	await store.configureAccount("a", { weight: 3 });
	const route = await pool.route("codex/gpt-fixture");
	const selected: string[] = [];
	for (let index = 0; index < 8; index += 1) {
		// biome-ignore lint/performance/noAwaitInLoops: Verify sequential weighted scheduling, not simultaneous reservation.
		const lease = await pool.acquire(route, new Set());
		selected.push(lease.accountId);
		lease.finish({
			kind: "complete",
			usage: { inputTokens: 2, outputTokens: 3 },
		});
		lease.finish({
			kind: "complete",
			usage: { inputTokens: 100, outputTokens: 100 },
		});
	}
	expect(selected.filter((id) => id === "a")).toHaveLength(6);
	expect(selected.filter((id) => id === "b")).toHaveLength(2);
	expect(pool.stats()).toEqual({
		completed: 8,
		failed: 0,
		inputTokens: 16,
		outputTokens: 24,
		requests: 8,
	});
});

test("reservations enforce account capacity and exact pins, cancellation releases capacity", async () => {
	const { pool, store } = await fixture();
	await Promise.all([
		store.configureAccount("a", { maxConcurrency: 1 }),
		store.configureAccount("b", { maxConcurrency: 1 }),
	]);
	const route = await pool.route("gpt-fixture");
	const [first, second] = await Promise.all([
		pool.acquire(route, new Set()),
		pool.acquire(route, new Set()),
	]);
	expect(first.accountId).not.toBe(second.accountId);
	await expect(pool.acquire(route, new Set())).rejects.toMatchObject({
		status: 429,
	});
	await expect(
		pool.acquire(await pool.route("a/gpt-fixture"), new Set())
	).rejects.toMatchObject({ status: 429 });
	first.finish({ kind: "cancel" });
	const freed = await pool.acquire(route, new Set());
	expect(freed.accountId).toBe(first.accountId);
	freed.finish({ kind: "complete" });
	second.finish({ kind: "complete" });
});

test("priority, disable, least busy, and session affinity select only eligible accounts", async () => {
	const { pool, store } = await fixture();
	await store.configureProxy({ aliases: [], strategy: "least-busy" });
	await store.configureAccount("b", { priority: 10 });
	const route = await pool.route("codex/gpt-fixture");
	const priority = await pool.acquire(route, new Set());
	expect(priority.accountId).toBe("b");
	priority.finish({ kind: "complete" });
	await store.configureAccount("b", { priority: 0 });
	const one = await pool.acquire(route, new Set(), "chat-session");
	const sticky = await pool.acquire(route, new Set(), "chat-session");
	expect(sticky.accountId).toBe(one.accountId);
	one.finish({ kind: "complete" });
	sticky.finish({ kind: "complete" });
	await store.configureAccount("a", { enabled: false });
	const enabled = await pool.acquire(route, new Set());
	expect(enabled.accountId).toBe("b");
	enabled.finish({ kind: "complete" });
});

test("unknown quota blocks every model and survives token refresh until Retry-After", async () => {
	const { pool, store, time } = await fixture();
	const route = await pool.route("a/gpt-fixture");
	const lease = await pool.acquire(route, new Set());
	lease.finish({ kind: "error", retryAfterMs: 10_000, status: 429 });
	await store.put({ ...ACCOUNT, accessToken: "refreshed-test-only" });
	await expect(
		pool.acquire(await pool.route("a/gpt-other"), new Set())
	).rejects.toMatchObject({ retryAfterMs: 10_000, status: 429 });
	time(110_001);
	const ready = await pool.acquire(route, new Set());
	ready.finish({ kind: "complete" });
});

test("terminal auth rejects until reauthentication and pool fallback never changes model", async () => {
	const { pool, store } = await fixture();
	const pinned = await pool.route("a/gpt-fixture");
	const lease = await pool.acquire(pinned, new Set());
	lease.finish({ kind: "error", status: 401 });
	const fallback = await pool.acquire(
		await pool.route("codex/gpt-fixture"),
		new Set()
	);
	expect(fallback.accountId).toBe("b");
	fallback.finish({ kind: "complete" });
	await store.put({ ...ACCOUNT, accessToken: "reauthenticated-test-only" });
	const ready = await pool.acquire(pinned, new Set());
	expect(ready.accountId).toBe("a");
	ready.finish({ kind: "complete" });
});

test("aliases and provider prefixes reject ambiguity, conflicting pins, and key scope bypass", async () => {
	const { pool, store, keys } = await fixture();
	await store.put({
		...ACCOUNT,
		authMode: "claude",
		id: "c",
		provider: "claude",
	});
	await store.configureProxy({
		aliases: [{ id: "coding", model: "gpt-fixture", provider: "codex" }],
		strategy: "fill-first",
	});
	expect(await pool.route("coding")).toMatchObject({
		model: "gpt-fixture",
		provider: "codex",
	});
	await expect(pool.route("custom-model")).rejects.toMatchObject({
		status: 400,
	});
	await expect(
		pool.route("claude/claude-fixture", "codex")
	).rejects.toMatchObject({ status: 400 });
	await expect(
		pool.route("a/gpt-fixture", undefined, "b")
	).rejects.toMatchObject({ status: 400 });
	const created = await keys.create({
		allowedAccounts: ["b"],
		allowedModels: ["coding"],
		allowedProviders: ["codex"],
		label: "Scoped",
	});
	const key = await keys.authenticate(
		new Request("http://localhost/v1/models", {
			headers: { authorization: `Bearer ${created.key}` },
			signal: SIGNAL,
		})
	);
	const lease = await pool.acquire(
		await pool.route("coding", undefined, undefined, key),
		new Set(),
		undefined,
		key
	);
	expect(lease.accountId).toBe("b");
	lease.finish({ kind: "complete" });
	await expect(
		pool.route("claude/claude-fixture", undefined, undefined, key)
	).rejects.toMatchObject({ status: 403 });
	await expect(
		pool.acquire(
			await pool.route("coding", undefined, "a", key),
			new Set(),
			undefined,
			key
		)
	).rejects.toMatchObject({ status: 403 });
});

test("proxy keys are once revealed, hashed at rest, bounded, expired, and immediately revocable", async () => {
	const { keys, root, store, time } = await fixture();
	const created = await keys.create({
		expiresAt: 200_000,
		label: "App",
		requestsPerMinute: 1,
	});
	expect(created.key).toMatch(PROXY_SECRET);
	const bytes = await readFile(join(root, ".state", "ai", "accounts.enc"));
	expect(bytes.toString()).not.toContain(created.key);
	expect(JSON.stringify(await store.keys())).not.toContain(created.key);
	expect(JSON.stringify(await keys.list())).not.toContain("digest");
	const request = () =>
		new Request("http://localhost/v1/models", {
			headers: { "x-api-key": created.key },
		});
	await keys.authenticate(request());
	await expect(keys.authenticate(request())).rejects.toMatchObject({
		status: 429,
	});
	time(160_000);
	await keys.authenticate(request());
	await keys.revoke(created.record.id);
	await expect(keys.authenticate(request())).rejects.toMatchObject({
		status: 401,
	});
	const expiring = await keys.create({ expiresAt: 170_000, label: "Expires" });
	time(170_001);
	await expect(
		keys.authenticate(
			new Request("http://localhost/v1/models", {
				headers: { authorization: `Bearer ${expiring.key}` },
			})
		)
	).rejects.toMatchObject({ status: 401 });
});

test("account routing settings survive token refresh and encrypted store reload", async () => {
	const { root, store } = await fixture();
	await store.configureAccount("a", {
		enabled: false,
		label: "Personal",
		maxConcurrency: 3,
		priority: 12,
		weight: 4,
	});
	await store.put({ ...ACCOUNT, accessToken: "fresh-test-only" });
	expect(await new AiStore(root).get("a")).toMatchObject({
		accessToken: "fresh-test-only",
		enabled: false,
		label: "Personal",
		maxConcurrency: 3,
		priority: 12,
		weight: 4,
	});
});

test("a late 401 for an old grant cannot block a newer login observed by the dashboard", async () => {
	const { pool, store, root } = await fixture();
	const route = await pool.route("a/gpt-fixture");
	const old = await pool.acquire(route, new Set());
	await store.put({ ...ACCOUNT, accessToken: "new-login-test-only" });
	await pool.views(await new AiAccounts(root).list());
	old.finish({ kind: "error", status: 401 });
	const fresh = await pool.acquire(route, new Set());
	expect(fresh.accountId).toBe("a");
	fresh.finish({ kind: "complete" });
});

test("an unauthorized internally refreshed grant is blocked when next observed", async () => {
	const { pool, store } = await fixture();
	const route = await pool.route("a/gpt-fixture");
	const old = await pool.acquire(route, new Set());
	await store.put({
		...ACCOUNT,
		accessToken: "internally-refreshed-test-only",
	});
	old.finish({
		credentialFingerprint: createHash("sha256")
			.update("internally-refreshed-test-only")
			.digest("hex"),
		kind: "error",
		status: 401,
	});
	await expect(pool.acquire(route, new Set())).rejects.toMatchObject({
		status: 429,
	});
	await store.put({ ...ACCOUNT, accessToken: "new-valid-login-test-only" });
	const fresh = await pool.acquire(route, new Set());
	fresh.finish({ kind: "complete" });
});
