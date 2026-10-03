import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { protectPrivateDirectory } from "../private-files";
import {
	type AiCredential,
	AiError,
	type AiProxyConfig,
	type AiProxyKey,
} from "./types";

const credentialSchema = z.object({
	accessToken: z.string().min(1),
	accountId: z.string().optional(),
	authMode: z.enum(["siwc", "codex", "claude"]),
	clientId: z.string().min(1),
	email: z.string().optional(),
	enabled: z.boolean().optional(),
	expiresAt: z.number().finite().optional(),
	id: z.string().min(1),
	idToken: z.string().optional(),
	label: z.string(),
	maxConcurrency: z.number().int().min(1).max(32).optional(),
	priority: z.number().int().min(-100).max(100).optional(),
	provider: z.enum(["codex", "claude"]),
	refreshToken: z.string().optional(),
	scopes: z.array(z.string()).optional(),
	source: z.enum(["oauth", "codex-cli", "claude-cli", "token"]),
	subject: z.string().optional(),
	weight: z.number().int().min(1).max(100).optional(),
});
export const proxyConfigSchema = z.strictObject({
	aliases: z
		.array(
			z.strictObject({
				accountId: z.string().min(1).max(200).optional(),
				id: z
					.string()
					.min(1)
					.max(120)
					.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
				model: z
					.string()
					.min(1)
					.max(200)
					.refine((value) => !value.includes("/")),
				provider: z.enum(["codex", "claude"]),
			})
		)
		.max(100),
	strategy: z.enum(["round-robin", "fill-first", "least-busy"]),
});
export const accountConfigSchema = z.strictObject({
	enabled: z.boolean().optional(),
	label: z.string().trim().min(1).max(120).optional(),
	maxConcurrency: z.number().int().min(1).max(32).optional(),
	priority: z.number().int().min(-100).max(100).optional(),
	weight: z.number().int().min(1).max(100).optional(),
});
const proxyKeySchema = z.object({
	allowedAccounts: z.array(z.string().min(1).max(200)).max(100).optional(),
	allowedModels: z.array(z.string().min(1).max(320)).max(100).optional(),
	allowedProviders: z
		.array(z.enum(["codex", "claude"]))
		.max(2)
		.optional(),
	createdAt: z.number().finite(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	enabled: z.boolean(),
	expiresAt: z.number().finite().optional(),
	id: z.string().min(1),
	label: z.string().min(1).max(120),
	prefix: z.string().min(1),
	requestsPerMinute: z.number().int().min(1).max(10_000).optional(),
});
const vaultSchema = z.object({
	accounts: z.array(credentialSchema),
	hostId: z.string().min(1),
	keys: z.array(proxyKeySchema).default([]),
	proxy: proxyConfigSchema.default({ aliases: [], strategy: "round-robin" }),
	version: z.literal(1),
});
type Vault = z.infer<typeof vaultSchema>;

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameCredential(
	current: AiCredential,
	expected: AiCredential
): boolean {
	return (
		current.accessToken === expected.accessToken &&
		current.refreshToken === expected.refreshToken &&
		current.clientId === expected.clientId &&
		current.authMode === expected.authMode &&
		current.expiresAt === expected.expiresAt
	);
}

/** Encrypted local secrets, atomic writes, and one mutation queue per hub process. */
export class AiStore {
	private readonly directory: string;
	private loaded?: Promise<Vault>;
	private protection?: Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(root: string) {
		this.directory = join(root, ".state", "ai");
	}

	private protect(): Promise<void> {
		this.protection ??= protectPrivateDirectory(this.directory);
		return this.protection;
	}

	private async key(create = false): Promise<Buffer> {
		const path = join(this.directory, "vault.key");
		if (create) {
			await mkdir(this.directory, { mode: 0o700, recursive: true });
		}
		await this.protect();
		if (create) {
			try {
				await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
			}
		}
		const key = await readFile(path);
		if (key.length !== 32) {
			throw new AiError(
				"Повреждён ключ AI-хранилища. Сохраните .state/ai и восстановите его из резервной копии.",
				500
			);
		}
		return key;
	}

	private async read(): Promise<Vault> {
		let bytes: Buffer;
		try {
			bytes = await readFile(join(this.directory, "accounts.enc"));
		} catch (error) {
			if (missing(error)) {
				return {
					accounts: [],
					hostId: `urn:uuid:${randomUUID()}`,
					keys: [],
					proxy: { aliases: [], strategy: "round-robin" },
					version: 1,
				};
			}
			throw new AiError("Не удалось прочитать AI-хранилище.", {
				cause: error,
				status: 500,
			});
		}
		try {
			if (bytes.length < 29) {
				throw new Error("invalid vault");
			}
			const decipher = createDecipheriv(
				"aes-256-gcm",
				await this.key(),
				bytes.subarray(0, 12)
			);
			decipher.setAuthTag(bytes.subarray(12, 28));
			const plaintext = Buffer.concat([
				decipher.update(bytes.subarray(28)),
				decipher.final(),
			]);
			return vaultSchema.parse(JSON.parse(plaintext.toString("utf8")));
		} catch (error) {
			if (error instanceof AiError) {
				throw error;
			}
			throw new AiError(
				"Не удалось прочитать AI-хранилище. Сохраните .state/ai; существующие подключения не перезаписаны.",
				{ cause: error, status: 500 }
			);
		}
	}

	private load(): Promise<Vault> {
		this.loaded ??= this.read();
		return this.loaded;
	}

	private async persist(value: Vault): Promise<void> {
		const key = await this.key(true);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const bytes = Buffer.concat([
			cipher.update(JSON.stringify(value), "utf8"),
			cipher.final(),
		]);
		const file = join(this.directory, "accounts.enc");
		const temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(
			temporary,
			Buffer.concat([iv, cipher.getAuthTag(), bytes]),
			{ flag: "wx", mode: 0o600 }
		);
		await rename(temporary, file);
	}

	private mutate(work: (vault: Vault) => Vault): Promise<void> {
		const next = this.queue.then(async () => {
			const value = work(await this.load());
			await this.persist(value);
			this.loaded = Promise.resolve(value);
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	async hostId(): Promise<string> {
		await this.mutate((vault) => vault);
		return (await this.load()).hostId;
	}

	async list(): Promise<AiCredential[]> {
		await this.queue;
		return structuredClone((await this.load()).accounts);
	}

	async get(id: string): Promise<AiCredential> {
		const account = (await this.list()).find((entry) => entry.id === id);
		if (!account) {
			throw new AiError(
				"Подключение не найдено. Выберите аккаунт заново.",
				404
			);
		}
		return account;
	}

	put(account: AiCredential): Promise<void> {
		const parsed = credentialSchema.parse(account);
		return this.mutate((vault) => {
			const existing = vault.accounts.find((entry) => entry.id === parsed.id);
			const settings = existing
				? {
						enabled: existing.enabled,
						label: existing.label,
						maxConcurrency: existing.maxConcurrency,
						priority: existing.priority,
						weight: existing.weight,
					}
				: {};
			return {
				...vault,
				accounts: [
					...vault.accounts.filter((entry) => entry.id !== parsed.id),
					{ ...parsed, ...settings },
				],
			};
		});
	}

	/** Refresh outcomes may only replace the grant they actually used, never a later sign-in. */
	async replaceCredential(
		expected: AiCredential,
		replacement: AiCredential
	): Promise<{ credential: AiCredential; updated: boolean }> {
		const parsed = credentialSchema.parse(replacement);
		let result: { credential: AiCredential; updated: boolean } | undefined;
		await this.mutate((vault) => {
			const current = vault.accounts.find((entry) => entry.id === expected.id);
			if (!current) {
				throw new AiError("Подключение отключено.", 401);
			}
			if (!sameCredential(current, expected)) {
				result = { credential: structuredClone(current), updated: false };
				return vault;
			}
			const credential = {
				...parsed,
				enabled: current.enabled,
				label: current.label,
				maxConcurrency: current.maxConcurrency,
				priority: current.priority,
				weight: current.weight,
			};
			result = { credential: structuredClone(credential), updated: true };
			return {
				...vault,
				accounts: vault.accounts.map((entry) =>
					entry.id === expected.id ? credential : entry
				),
			};
		});
		if (!result) {
			throw new AiError("Не удалось обновить подключение.", 500);
		}
		return result;
	}

	configureAccount(
		id: string,
		config: z.infer<typeof accountConfigSchema>
	): Promise<void> {
		const parsed = accountConfigSchema.parse(config);
		return this.mutate((vault) => {
			if (!vault.accounts.some((entry) => entry.id === id)) {
				throw new AiError("Подключение не найдено.", 404);
			}
			return {
				...vault,
				accounts: vault.accounts.map((entry) =>
					entry.id === id ? { ...entry, ...parsed } : entry
				),
			};
		});
	}

	async proxyConfig(): Promise<AiProxyConfig> {
		await this.queue;
		return structuredClone((await this.load()).proxy);
	}

	configureProxy(config: AiProxyConfig): Promise<void> {
		const parsed = proxyConfigSchema.parse(config);
		if (
			new Set(parsed.aliases.map((entry) => entry.id)).size !==
			parsed.aliases.length
		) {
			throw new AiError("Имена маршрутов должны быть уникальны.", 400);
		}
		return this.mutate((vault) => ({ ...vault, proxy: parsed }));
	}

	async keys(): Promise<AiProxyKey[]> {
		await this.queue;
		return structuredClone((await this.load()).keys);
	}

	putKey(key: AiProxyKey): Promise<void> {
		const parsed = proxyKeySchema.parse(key);
		return this.mutate((vault) => ({
			...vault,
			keys: [...vault.keys.filter((entry) => entry.id !== key.id), parsed],
		}));
	}

	revokeKey(id: string): Promise<void> {
		return this.mutate((vault) => {
			if (!vault.keys.some((entry) => entry.id === id)) {
				throw new AiError("Ключ не найден.", 404);
			}
			return {
				...vault,
				keys: vault.keys.map((entry) =>
					entry.id === id ? { ...entry, enabled: false } : entry
				),
			};
		});
	}

	remove(id: string): Promise<void> {
		return this.mutate((vault) => ({
			...vault,
			accounts: vault.accounts.filter((entry) => entry.id !== id),
		}));
	}

	removeCredential(expected: AiCredential): Promise<void> {
		return this.mutate((vault) => ({
			...vault,
			accounts: vault.accounts.filter(
				(entry) => entry.id !== expected.id || !sameCredential(entry, expected)
			),
		}));
	}
}
