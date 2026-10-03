import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sleep } from "bun";

import { AiModels } from "../src/ai/models";
import type {
	AiAccountModels,
	AiCredential,
	AiModelAlias,
	AiProxyKey,
} from "../src/ai/types";

function credential(
	id: string,
	provider: "codex" | "claude" = "codex"
): AiCredential {
	return {
		accessToken: `fake-${id}`,
		authMode: provider === "codex" ? "codex" : "claude",
		clientId: "fake-client",
		id,
		label: id,
		provider,
		source: "token",
	};
}

function remote(...ids: string[]): AiAccountModels {
	return { models: ids.map((id) => ({ id, name: id })), source: "remote" };
}

function key(config: Partial<AiProxyKey>): AiProxyKey {
	return {
		createdAt: 1,
		digest: "fake-digest",
		enabled: true,
		id: "key",
		label: "key",
		prefix: "dh_fake",
		...config,
	};
}

function fixture(
	initial: AiCredential[],
	read: (id: string) => AiAccountModels | Promise<AiAccountModels>
) {
	let now = 1_000_000;
	const accounts = new Map(initial.map((account) => [account.id, account]));
	const aliases: AiModelAlias[] = [];
	const calls: string[] = [];
	const store = {
		get: (id: string) => {
			const account = accounts.get(id);
			if (!account) {
				return Promise.reject(new Error("missing fixture account"));
			}
			return Promise.resolve({ ...account });
		},
		list: async () => [...accounts.values()].map((account) => ({ ...account })),
		proxyConfig: async () => ({
			aliases: [...aliases],
			strategy: "round-robin" as const,
		}),
	};
	const models = new AiModels(
		store,
		{
			models: async (id) => {
				calls.push(id);
				return await read(id);
			},
		},
		() => now
	);
	return {
		accounts,
		aliases,
		calls,
		models,
		tick: (ms: number) => {
			now += ms;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("discovery unions real account entitlements, preserves pinned membership and resolves aliases", async () => {
	const hub = fixture(
		[
			credential("a"),
			credential("b"),
			credential("c", "claude"),
			{ ...credential("disabled"), enabled: false },
		],
		(id) =>
			id === "c" ? remote("claude-fixture") : remote("gpt-common", `gpt-${id}`)
	);
	hub.aliases.push(
		{ id: "coding", model: "gpt-common", provider: "codex" },
		{ accountId: "a", id: "only-a", model: "gpt-a", provider: "codex" },
		{ id: "ghost", model: "never-discovered", provider: "codex" }
	);
	const inventory = await hub.models.inventory();
	expect(
		inventory.models.find((model) => model.id === "codex/gpt-common")
			?.accountIds
	).toEqual(["a", "b"]);
	expect(
		inventory.models.find((model) => model.id === "a/gpt-common")?.accountIds
	).toEqual(["a"]);
	expect(
		inventory.models.find((model) => model.id === "coding")?.accountIds
	).toEqual(["a", "b"]);
	expect(
		inventory.models.find((model) => model.id === "only-a")?.accountIds
	).toEqual(["a"]);
	expect(inventory.models.some((model) => model.id === "ghost")).toBe(false);
	expect(hub.calls).toEqual(["a", "b", "c"]);
	expect(
		inventory.accounts.every((account) => account.source === "remote")
	).toBe(true);
	const cached = await hub.models.inventory();
	expect(cached.accounts.every((account) => account.source === "cache")).toBe(
		true
	);
	expect(hub.calls).toHaveLength(3);
	await hub.models.inventory(undefined, true);
	expect(hub.calls).toHaveLength(6);
});

test("a valid empty inventory is authoritative while reference catalogue failure remains unknown", async () => {
	const a = credential("a");
	const b = credential("b");
	const hub = fixture([a, b], (id) =>
		id === "a"
			? remote()
			: {
					error: "Provider unavailable",
					models: [{ id: "gpt-reference", name: "Reference" }],
					source: "catalog",
					status: 502,
				}
	);
	const inventory = await hub.models.inventory();
	expect(inventory.models).toEqual([]);
	expect(
		inventory.accounts.map((account) => [account.source, account.modelCount])
	).toEqual([
		["remote", 0],
		["unavailable", 0],
	]);
	expect(hub.models.supports(a, "gpt-reference")).toBe(false);
	expect(hub.models.supports(b, "gpt-reference")).toBeUndefined();
	await hub.models.inventory(undefined, true);
	expect(hub.calls.filter((id) => id === "b")).toHaveLength(1);
});

test("partial discovery failure retains fresh data, marks stale data, retires it and clears revoked grants", async () => {
	let failure = false;
	let status = 502;
	const hub = fixture([credential("a"), credential("b")], (id) =>
		id === "a" && failure
			? {
					error: "Safe provider failure",
					models: [],
					source: "catalog",
					status,
				}
			: remote(`gpt-${id}`)
	);
	await hub.models.inventory();
	failure = true;
	const fresh = await hub.models.inventory(undefined, true);
	expect(
		fresh.models.find((model) => model.id === "codex/gpt-a")
	).toMatchObject({ available: true, source: "cache" });
	hub.tick(5 * 60_000);
	const stale = await hub.models.inventory();
	expect(
		stale.models.find((model) => model.id === "codex/gpt-a")
	).toMatchObject({ available: false, source: "stale" });
	expect(
		stale.models.find((model) => model.id === "codex/gpt-b")?.available
	).toBe(true);
	hub.tick(10 * 60_000);
	const retired = await hub.models.inventory();
	expect(retired.models.some((model) => model.id === "codex/gpt-a")).toBe(
		false
	);
	failure = false;
	hub.tick(30_000);
	await hub.models.inventory();
	failure = true;
	status = 401;
	const revoked = await hub.models.inventory(undefined, true);
	expect(revoked.models.some((model) => model.id === "codex/gpt-a")).toBe(
		false
	);
	expect(hub.models.supports(credential("a"), "gpt-a")).toBeUndefined();
});

test("scoped alias discovery only reads its account and never broadens canonical model access", async () => {
	const hub = fixture(
		[credential("a"), credential("b"), credential("c", "claude")],
		() => remote("gpt-target", "gpt-other")
	);
	hub.aliases.push({
		accountId: "a",
		id: "coding",
		model: "gpt-target",
		provider: "codex",
	});
	const inventory = await hub.models.inventory(
		key({ allowedModels: ["coding"] })
	);
	expect(hub.calls).toEqual(["a"]);
	expect(inventory.models.map((model) => model.id)).toEqual(["coding"]);
	expect(inventory.models[0]?.accountIds).toEqual(["a"]);
	const restricted = await hub.models.inventory(
		key({
			allowedAccounts: ["b"],
			allowedModels: ["codex/gpt-target"],
			allowedProviders: ["codex"],
		})
	);
	expect(restricted.models.map((model) => model.id)).toEqual([
		"codex/gpt-target",
		"b/gpt-target",
	]);
	expect(
		restricted.models.every((model) => model.accountIds.join() === "b")
	).toBe(true);
});

test("raw model scopes do not duplicate an alias with the same public ID", async () => {
	const hub = fixture([credential("a", "claude")], () => remote("foo", "bar"));
	hub.aliases.push({ id: "foo", model: "bar", provider: "claude" });
	const inventory = await hub.models.inventory(key({ allowedModels: ["foo"] }));
	expect(inventory.models).toHaveLength(1);
	expect(inventory.models[0]).toMatchObject({
		id: "foo",
		kind: "alias",
		model: "bar",
	});
	const raw = fixture([credential("a")], () => remote("gpt-raw"));
	expect(
		(
			await raw.models.inventory(key({ allowedModels: ["gpt-raw"] }))
		).models.map((model) => model.id)
	).toEqual(["gpt-raw"]);
});

test("coalesced discovery survives one caller cancellation and respects the global concurrency limit", async () => {
	const gate = deferred<AiAccountModels>();
	const hub = fixture([credential("a")], () => gate.promise);
	const controller = new AbortController();
	const cancelled = hub.models.inventory(undefined, false, controller.signal);
	const survivor = hub.models.inventory();
	await sleep(1);
	controller.abort();
	await expect(cancelled).rejects.toMatchObject({ status: 499 });
	gate.resolve(remote("gpt-shared"));
	expect((await survivor).models[0]?.id).toBe("codex/gpt-shared");
	expect(hub.calls).toEqual(["a"]);
	const manyGate = deferred<AiAccountModels>();
	const many = fixture(
		Array.from({ length: 9 }, (_, index) => credential(`a${index}`)),
		() => manyGate.promise
	);
	const request = many.models.inventory();
	await sleep(1);
	expect(many.calls).toHaveLength(4);
	manyGate.resolve(remote("gpt-shared"));
	await request;
	expect(many.calls).toHaveLength(9);
});

test("re-login during discovery never publishes the old grant and invalidates previous support", async () => {
	const first = deferred<AiAccountModels>();
	let calls = 0;
	const hub = fixture([credential("a")], () => {
		calls += 1;
		return calls === 1 ? first.promise : remote("gpt-new");
	});
	const pending = hub.models.inventory();
	await sleep(1);
	hub.accounts.set("a", { ...credential("a"), accessToken: "fake-new-login" });
	first.resolve(remote("gpt-old"));
	const inventory = await pending;
	expect(inventory.models.some((model) => model.model === "gpt-old")).toBe(
		false
	);
	expect(inventory.models[0]?.id).toBe("codex/gpt-new");
	expect(hub.calls).toHaveLength(2);
	expect(hub.models.supports(credential("a"), "gpt-new")).toBeUndefined();
});

test("disconnected and disabled accounts are removed while their discovery is still pending", async () => {
	const gate = deferred<AiAccountModels>();
	const hub = fixture([credential("a"), credential("b")], () => gate.promise);
	const pending = hub.models.inventory();
	await sleep(1);
	hub.accounts.delete("a");
	hub.accounts.set("b", { ...credential("b"), enabled: false });
	gate.resolve(remote("gpt-old"));
	expect((await pending).models).toEqual([]);
});

test("an actual inference auth failure retires only the dispatched grant, including pending discoveries", async () => {
	const gate = deferred<AiAccountModels>();
	let result = Promise.resolve(remote("gpt-good"));
	const hub = fixture([credential("a")], () => result);
	await hub.models.inventory();
	hub.models.invalidate("a", "old-or-other-grant");
	expect((await hub.models.inventory()).models[0]?.available).toBe(true);
	result = gate.promise;
	const refresh = hub.models.inventory(undefined, true);
	await sleep(1);
	hub.models.invalidate(
		"a",
		createHash("sha256").update(credential("a").accessToken).digest("hex")
	);
	gate.resolve(remote("gpt-late"));
	expect((await refresh).models).toEqual([]);
	expect((await hub.models.inventory(undefined, true)).models).toEqual([]);
	expect(hub.calls).toHaveLength(2);
	result = Promise.resolve(remote("gpt-good"));
	hub.accounts.set("a", { ...credential("a"), accessToken: "new-fake-grant" });
	expect((await hub.models.inventory()).models[0]?.available).toBe(true);
	hub.models.invalidate(
		"a",
		createHash("sha256").update(credential("a").accessToken).digest("hex")
	);
	expect((await hub.models.inventory()).models[0]?.available).toBe(true);
});
