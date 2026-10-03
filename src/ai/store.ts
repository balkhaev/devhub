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
import { type AiCredential, AiError } from "./types";

const credentialSchema = z.object({
	accessToken: z.string().min(1),
	accountId: z.string().optional(),
	authMode: z.enum(["siwc", "codex", "claude"]),
	clientId: z.string().min(1),
	email: z.string().optional(),
	expiresAt: z.number().finite().optional(),
	id: z.string().min(1),
	idToken: z.string().optional(),
	label: z.string(),
	provider: z.enum(["codex", "claude"]),
	refreshToken: z.string().optional(),
	scopes: z.array(z.string()).optional(),
	source: z.enum(["oauth", "codex-cli", "claude-cli", "token"]),
	subject: z.string().optional(),
});
const vaultSchema = z.object({
	accounts: z.array(credentialSchema),
	hostId: z.string().min(1),
	version: z.literal(1),
});
type Vault = z.infer<typeof vaultSchema>;

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
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
				return { accounts: [], hostId: `urn:uuid:${randomUUID()}`, version: 1 };
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
		return this.mutate((vault) => ({
			...vault,
			accounts: [
				...vault.accounts.filter((entry) => entry.id !== parsed.id),
				parsed,
			],
		}));
	}

	remove(id: string): Promise<void> {
		return this.mutate((vault) => ({
			...vault,
			accounts: vault.accounts.filter((entry) => entry.id !== id),
		}));
	}
}
