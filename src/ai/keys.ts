import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

import type { AiStore } from "./store";
import { AiError, type AiProxyKey, type AiProxyKeyView } from "./types";

const BEARER = /^Bearer ([^\s]+)$/i;

export const createKeySchema = z.strictObject({
	allowedAccounts: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(100)
		.optional(),
	allowedModels: z.array(z.string().min(1).max(320)).min(1).max(100).optional(),
	allowedProviders: z
		.array(z.enum(["codex", "claude"]))
		.min(1)
		.max(2)
		.optional(),
	expiresAt: z.number().finite().optional(),
	label: z.string().trim().min(1).max(120),
	requestsPerMinute: z.number().int().min(1).max(10_000).optional(),
});

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export class AiProxyKeys {
	private readonly store: AiStore;
	private readonly now: () => number;
	private readonly usage = new Map<
		string,
		{ lastUsedAt: number; requests: number; window: number; count: number }
	>();

	constructor(store: AiStore, now = Date.now) {
		this.store = store;
		this.now = now;
	}

	private view(key: AiProxyKey): AiProxyKeyView {
		const usage = this.usage.get(key.id);
		return {
			allowedAccounts: key.allowedAccounts,
			allowedModels: key.allowedModels,
			allowedProviders: key.allowedProviders,
			createdAt: key.createdAt,
			enabled: key.enabled,
			expiresAt: key.expiresAt,
			id: key.id,
			label: key.label,
			lastUsedAt: usage?.lastUsedAt,
			prefix: key.prefix,
			requests: usage?.requests ?? 0,
			requestsPerMinute: key.requestsPerMinute,
		};
	}

	async list(): Promise<AiProxyKeyView[]> {
		return (await this.store.keys()).map((key) => this.view(key));
	}

	async create(
		input: z.infer<typeof createKeySchema>
	): Promise<{ key: string; record: AiProxyKeyView }> {
		const data = createKeySchema.parse(input);
		if (data.expiresAt !== undefined && data.expiresAt <= this.now()) {
			throw new AiError("Срок действия ключа должен быть в будущем.", 400);
		}
		const secret = `dh_${randomBytes(32).toString("base64url")}`;
		const key: AiProxyKey = {
			...data,
			createdAt: this.now(),
			digest: digest(secret),
			enabled: true,
			id: randomUUID(),
			prefix: secret.slice(0, 11),
		};
		await this.store.putKey(key);
		return { key: secret, record: this.view(key) };
	}

	/** Application keys authorize only /v1 and never gain DevHub administration access. */
	async authenticate(request: Request): Promise<AiProxyKey> {
		const authorization = request.headers.get("authorization");
		const bearer = authorization?.match(BEARER)?.[1];
		const anthropic = request.headers.get("x-api-key") ?? undefined;
		if (
			(authorization && !bearer) ||
			(bearer && anthropic && bearer !== anthropic)
		) {
			throw new AiError("Некорректный ключ прокси.", 401);
		}
		const secret = bearer ?? anthropic;
		if (!secret || secret.length > 200) {
			throw new AiError(
				"Нужен ключ прокси: Authorization: Bearer или x-api-key.",
				401
			);
		}
		const candidate = Buffer.from(digest(secret), "hex");
		const key = (await this.store.keys()).find((entry) =>
			timingSafeEqual(candidate, Buffer.from(entry.digest, "hex"))
		);
		if (
			!key?.enabled ||
			(key.expiresAt !== undefined && key.expiresAt <= this.now())
		) {
			throw new AiError("Ключ прокси недействителен или отозван.", 401);
		}
		const now = this.now();
		const window = Math.floor(now / 60_000);
		const previous = this.usage.get(key.id);
		const count = previous?.window === window ? previous.count : 0;
		if (key.requestsPerMinute && count >= key.requestsPerMinute) {
			throw new AiError(
				"Достигнут лимит запросов ключа прокси за минуту.",
				429
			);
		}
		this.usage.set(key.id, {
			count: count + 1,
			lastUsedAt: now,
			requests: (previous?.requests ?? 0) + 1,
			window,
		});
		return key;
	}

	revoke(id: string): Promise<void> {
		return this.store.revokeKey(id);
	}
}
