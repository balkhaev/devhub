import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TOKEN = /^[a-f0-9]{64}$/;

/** A local CLI can act without a browser Origin; its credential never leaves this machine. */
export async function clientToken(root: string): Promise<string> {
	const file = join(root, ".state", "client-token");
	await mkdir(dirname(file), { recursive: true });
	try {
		await writeFile(file, randomBytes(32).toString("hex"), {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
	const token = (await readFile(file, "utf8")).trim();
	if (!TOKEN.test(token)) {
		throw new Error(`Повреждён ${file}; удалите его и перезапустите пульт`);
	}
	return token;
}

export function authenticatedClient(request: Request, token: string): boolean {
	// Browser requests must follow the browser Origin rules even if they carry a token.
	if (request.headers.has("origin")) {
		return false;
	}
	const supplied = request.headers.get("x-devhub-client") ?? "";
	return (
		TOKEN.test(supplied) &&
		timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
	);
}

export async function requestHub(
	address: string,
	path: string,
	token: string,
	action = false
): Promise<unknown> {
	const response = await fetch(new URL(path, address), {
		headers: action ? { "x-devhub-client": token } : {},
		method: action ? "POST" : "GET",
		signal: AbortSignal.timeout(240_000),
	});
	const result = (await response.json()) as {
		error?: string;
		result?: unknown;
	};
	if (!response.ok) {
		throw new Error(result.error ?? `Пульт ответил HTTP ${response.status}`);
	}
	if (action && Array.isArray(result.result) && result.result.length) {
		throw new Error(result.result.join("\n"));
	}
	return result;
}
