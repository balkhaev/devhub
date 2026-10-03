import { createHash } from "node:crypto";

import type { AiInference } from "./inference";
import { inferProvider } from "./pool";
import type { AiStore } from "./store";
import {
	type AiAccountModelView,
	type AiAvailableModel,
	type AiCredential,
	AiError,
	type AiModel,
	type AiModelAlias,
	type AiModelsInventory,
	type AiProvider,
	type AiProxyKey,
	safeAiError,
} from "./types";

const FRESH_TTL = 5 * 60_000;
const STALE_TTL = 15 * 60_000;
const FAILURE_TTL = 30_000;
const MAX_DISCOVERY = 4;

interface Snapshot {
	checkedAt: number;
	models: AiModel[];
}

interface CacheEntry {
	accessFingerprint: string;
	error?: string;
	fingerprint: string;
	nextAttempt: number;
	pending?: Promise<void>;
	revoked?: boolean;
	snapshot?: Snapshot;
}

interface Discovery {
	account: AiCredential;
	entry: CacheEntry;
	remote: boolean;
}

function fingerprint(account: AiCredential): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				account.accessToken,
				account.authMode,
				account.clientId,
				account.accountId,
				account.subject,
				account.provider,
			])
		)
		.digest("hex");
}

function connected(account: AiCredential, now: number): boolean {
	return (
		account.enabled !== false &&
		(!account.expiresAt || account.expiresAt > now || !!account.refreshToken)
	);
}

function allowedAccount(account: AiCredential, key?: AiProxyKey): boolean {
	return (
		(!key?.allowedAccounts || key.allowedAccounts.includes(account.id)) &&
		(!key?.allowedProviders || key.allowedProviders.includes(account.provider))
	);
}

function discoverable(
	account: AiCredential,
	aliases: AiModelAlias[],
	key?: AiProxyKey
): boolean {
	if (!allowedAccount(account, key)) {
		return false;
	}
	return (
		!key?.allowedModels ||
		key.allowedModels.some((id) => {
			const alias = aliases.find((entry) => entry.id === id);
			if (alias) {
				return (
					alias.provider === account.provider &&
					(!alias.accountId || alias.accountId === account.id)
				);
			}
			return (
				(!id.includes("/") &&
					(!inferProvider(id) || inferProvider(id) === account.provider)) ||
				id.startsWith(`${account.provider}/`) ||
				id.startsWith(`${account.id}/`)
			);
		})
	);
}

/** A cancelled caller leaves a coalesced discovery available to other callers. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) {
		return promise;
	}
	return new Promise((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(new AiError("AI-запрос отменён.", 499));
		};
		const cleanup = () => signal.removeEventListener("abort", abort);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			}
		);
	});
}

function mergePoolModel(
	models: Map<string, AiAvailableModel>,
	model: AiAvailableModel
): void {
	const previous = models.get(model.id);
	if (!previous || (model.available && !previous.available)) {
		models.set(model.id, { ...model, accountIds: [...model.accountIds] });
		return;
	}
	if (model.available === previous.available) {
		previous.accountIds.push(...model.accountIds);
		if (model.source === "remote") {
			previous.source = "remote";
		}
	}
}

function scopedModels(
	models: AiAvailableModel[],
	aliases: AiModelAlias[],
	key?: AiProxyKey,
	soleProvider?: AiProvider
): AiAvailableModel[] {
	return models.flatMap((model) => {
		if (
			!key?.allowedModels ||
			key.allowedModels.includes(model.id) ||
			key.allowedModels.includes(`${model.provider}/${model.model}`)
		) {
			return [model];
		}
		if (
			model.kind === "pool" &&
			key.allowedModels.includes(model.model) &&
			!aliases.some((alias) => alias.id === model.model) &&
			(inferProvider(model.model) ?? soleProvider) === model.provider
		) {
			return [{ ...model, id: model.model }];
		}
		return [];
	});
}

/** Provider entitlement is cached per grant; a reference catalogue is never advertised as discovered. */
export class AiModels {
	private readonly store: Pick<AiStore, "list" | "get" | "proxyConfig">;
	private readonly inference: Pick<AiInference, "models">;
	private readonly now: () => number;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly waiting: (() => void)[] = [];
	private active = 0;

	constructor(
		store: Pick<AiStore, "list" | "get" | "proxyConfig">,
		inference: Pick<AiInference, "models">,
		now = Date.now
	) {
		this.store = store;
		this.inference = inference;
		this.now = now;
	}

	/** Undefined means unknown: custom models remain usable without a discovery request. */
	supports(account: AiCredential, model: string): boolean | undefined {
		const entry = this.cache.get(account.id);
		if (
			!entry?.snapshot ||
			entry.fingerprint !== fingerprint(account) ||
			this.now() - entry.snapshot.checkedAt >= FRESH_TTL
		) {
			return undefined;
		}
		return entry.snapshot.models.some((candidate) => candidate.id === model);
	}

	/** A late failure of an older request must never revoke a newer login's catalogue. */
	invalidate(accountId: string, accessFingerprint?: string): void {
		const entry = this.cache.get(accountId);
		if (
			!(entry && accessFingerprint) ||
			entry.accessFingerprint !== accessFingerprint
		) {
			return;
		}
		entry.snapshot = undefined;
		entry.error = "Требуется повторный вход в подписку.";
		entry.revoked = true;
		entry.nextAttempt = Number.POSITIVE_INFINITY;
	}

	private async limited<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= MAX_DISCOVERY) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		} else {
			this.active += 1;
		}
		try {
			return await task();
		} finally {
			const next = this.waiting.shift();
			if (next) {
				next();
			} else {
				this.active -= 1;
			}
		}
	}

	private entry(account: AiCredential): CacheEntry {
		const grant = fingerprint(account);
		let entry = this.cache.get(account.id);
		if (!entry || entry.fingerprint !== grant) {
			entry = {
				accessFingerprint: createHash("sha256")
					.update(account.accessToken)
					.digest("hex"),
				fingerprint: grant,
				nextAttempt: 0,
			};
			this.cache.set(account.id, entry);
		}
		return entry;
	}

	private async discover(
		account: AiCredential,
		refresh: boolean
	): Promise<Discovery> {
		const entry = this.entry(account);
		let remote = false;
		if (entry.pending) {
			await entry.pending;
			remote = true;
		} else if ((refresh && !entry.error) || this.now() >= entry.nextAttempt) {
			entry.pending = this.limited(() => this.fetch(account, entry));
			try {
				await entry.pending;
				remote = true;
			} finally {
				entry.pending = undefined;
			}
		}
		return { account, entry, remote };
	}

	private async fetch(account: AiCredential, entry: CacheEntry): Promise<void> {
		if (entry.revoked) {
			return;
		}
		try {
			const result = await this.inference.models(
				account.id,
				AbortSignal.timeout(30_000)
			);
			const current = await this.store.get(account.id);
			if (entry.revoked || fingerprint(current) !== entry.fingerprint) {
				return;
			}
			if (result.source === "remote") {
				entry.snapshot = {
					checkedAt: this.now(),
					models: result.models.map((model) => ({ ...model })),
				};
				entry.error = undefined;
				entry.nextAttempt = this.now() + FRESH_TTL;
			} else {
				entry.error = result.error ?? "Не удалось получить модели провайдера.";
				entry.nextAttempt = this.now() + FAILURE_TTL;
				if (result.status === 401 || result.status === 403) {
					entry.snapshot = undefined;
				}
			}
		} catch (error) {
			if (entry.revoked) {
				return;
			}
			entry.error = safeAiError(error).error;
			entry.nextAttempt = this.now() + FAILURE_TTL;
		}
	}

	private view(result: Discovery): AiAccountModelView {
		const { account, entry } = result;
		const { snapshot } = entry;
		const age = snapshot
			? this.now() - snapshot.checkedAt
			: Number.POSITIVE_INFINITY;
		let source: AiAccountModelView["source"] = "unavailable";
		if (age < FRESH_TTL) {
			source = result.remote && !entry.error ? "remote" : "cache";
		} else if (age < STALE_TTL) {
			source = "stale";
		}
		return {
			accountId: account.id,
			checkedAt: snapshot?.checkedAt,
			error: entry.error,
			modelCount: source === "unavailable" ? 0 : (snapshot?.models.length ?? 0),
			provider: account.provider,
			source,
		};
	}

	async inventory(
		key?: AiProxyKey,
		refresh = false,
		signal?: AbortSignal
	): Promise<AiModelsInventory> {
		if (signal?.aborted) {
			throw new AiError("AI-запрос отменён.", 499);
		}
		const accounts = await this.store.list();
		const { aliases } = await this.store.proxyConfig();
		const ids = new Set(accounts.map((account) => account.id));
		for (const id of this.cache.keys()) {
			if (!ids.has(id)) {
				this.cache.delete(id);
			}
		}
		const selected = accounts.filter(
			(account) =>
				connected(account, this.now()) && discoverable(account, aliases, key)
		);
		const initial = await abortable(
			Promise.all(selected.map((account) => this.discover(account, refresh))),
			signal
		);
		// A refresh may rotate the grant. Re-read once; never publish the previous login's discovery.
		const latest = await this.store.list();
		const config = await this.store.proxyConfig();
		const current = latest.filter(
			(account) =>
				connected(account, this.now()) &&
				discoverable(account, config.aliases, key)
		);
		const replaced = current.filter((account) =>
			selected.some(
				(old) =>
					old.id === account.id && fingerprint(old) !== fingerprint(account)
			)
		);
		const refreshed = await abortable(
			Promise.all(replaced.map((account) => this.discover(account, false))),
			signal
		);
		const discovered = new Map(
			[...initial, ...refreshed].map((result) => [result.account.id, result])
		);
		const finalAccounts = await this.store.list();
		const finalConfig = await this.store.proxyConfig();
		const results = finalAccounts.flatMap((account): Discovery[] => {
			if (
				!(
					connected(account, this.now()) &&
					discoverable(account, finalConfig.aliases, key)
				)
			) {
				return [];
			}
			const entry = this.cache.get(account.id);
			if (!entry || entry.fingerprint !== fingerprint(account)) {
				return [];
			}
			return [
				{
					account,
					entry,
					remote:
						discovered.get(account.id)?.entry === entry &&
						(discovered.get(account.id)?.remote ?? false),
				},
			];
		});
		const views = results.map((result) => this.view(result));
		const providers = new Set(
			finalAccounts
				.filter((account) => account.enabled !== false)
				.map((account) => account.provider)
		);
		const soleProvider = providers.size === 1 ? [...providers][0] : undefined;
		return {
			accounts: views,
			models: this.aggregate(
				results,
				views,
				finalConfig.aliases,
				key,
				soleProvider
			),
			updatedAt: this.now(),
		};
	}

	private aggregate(
		results: Discovery[],
		views: AiAccountModelView[],
		aliases: AiModelAlias[],
		key?: AiProxyKey,
		soleProvider?: AiProvider
	): AiAvailableModel[] {
		const models = new Map<string, AiAvailableModel>();
		for (const [index, result] of results.entries()) {
			const view = views[index];
			if (!view || view.source === "unavailable") {
				continue;
			}
			for (const model of result.entry.snapshot?.models ?? []) {
				const base = {
					accountIds: [result.account.id],
					available: view.source !== "stale",
					model: model.id,
					name: model.name,
					provider: result.account.provider,
					source: view.source,
				};
				const id = `${result.account.provider}/${model.id}`;
				mergePoolModel(models, { ...base, id, kind: "pool" });
				const pinned = `${result.account.id}/${model.id}`;
				models.set(pinned, {
					...base,
					accountIds: [...base.accountIds],
					id: pinned,
					kind: "account",
				});
			}
		}
		for (const alias of aliases) {
			const target = models.get(
				`${alias.accountId ?? alias.provider}/${alias.model}`
			);
			if (target) {
				models.set(alias.id, {
					...target,
					accountIds: [...target.accountIds],
					id: alias.id,
					kind: "alias",
					name: alias.id,
				});
			}
		}
		return scopedModels([...models.values()], aliases, key, soleProvider);
	}
}
