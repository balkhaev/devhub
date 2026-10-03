import { z } from "zod";

import type { AiAccounts } from "./accounts";
import { AI_PROVIDERS, type AiInference } from "./inference";
import { AiError, safeAiError } from "./types";

const MAX_BODY = 1_048_576;
const providerSchema = z.strictObject({
	accountId: z.string().max(200).optional(),
	provider: z.enum(["codex", "claude"]),
});
const codeSchema = z.strictObject({ code: z.string().min(1).max(8192) });
const FLOW_PATH = /^\/api\/ai\/oauth\/([a-f0-9]{32})$/;
const MODELS_PATH = /^\/api\/ai\/accounts\/([^/]+)\/models$/;
const COMPLETE_PATH = /^\/api\/ai\/oauth\/([^/]+)\/complete$/;
const DISCONNECT_PATH = /^\/api\/ai\/accounts\/([^/]+)\/disconnect$/;
const HTML_SPECIAL = /[&<>"]/g;
const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
		status,
	});
}

/** Read incrementally so chunked bodies cannot bypass Content-Length limits. */
async function body(request: Request): Promise<unknown> {
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
		"application/json"
	) {
		throw new AiError("Нужен Content-Type: application/json.", 415);
	}
	if (Number(request.headers.get("content-length")) > MAX_BODY) {
		throw new AiError("AI-запрос превышает 1 МБ.", 413);
	}
	const reader = request.body?.getReader();
	if (!reader) {
		throw new AiError("Нужно JSON-тело запроса.", 400);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			// biome-ignore lint/performance/noAwaitInLoops: A request body must be consumed sequentially with a bounded buffer.
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			size += chunk.value.byteLength;
			if (size > MAX_BODY) {
				await reader.cancel();
				throw new AiError("AI-запрос превышает 1 МБ.", 413);
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new AiError("Некорректное JSON-тело AI-запроса.", {
			cause: error,
			status: 400,
		});
	}
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		throw new AiError("Некорректные параметры AI-запроса.", 400);
	}
	return parsed.data;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AiError("Нужен JSON-объект запроса.", 400);
	}
	return value as Record<string, unknown>;
}

/** AI requests never use the service journal: prompts, auth codes and upstream bodies stay private. */
export class AiApi {
	private readonly accounts: AiAccounts;
	private readonly inference: AiInference;
	constructor(accounts: AiAccounts, inference: AiInference) {
		this.accounts = accounts;
		this.inference = inference;
	}

	async handle(
		request: Request,
		authorized: boolean,
		origin: string,
		ready: boolean
	): Promise<Response> {
		if (!authorized) {
			return json(
				{
					error:
						"AI API принимает запросы со страницы DevHub или с x-devhub-client.",
				},
				403
			);
		}
		if (!ready) {
			return json({ error: "Пульт ещё запускается." }, 503);
		}
		try {
			const path = new URL(request.url).pathname;
			if (request.method === "GET") {
				return await this.get(request, path);
			}
			if (request.method === "POST") {
				return await this.post(request, path, origin);
			}
			return json({ error: "Метод не поддерживается." }, 405);
		} catch (error) {
			const safe = safeAiError(error);
			return json({ error: safe.error }, safe.status);
		}
	}

	private async get(request: Request, path: string): Promise<Response> {
		if (path === "/api/ai/state") {
			return json({
				accounts: await this.accounts.list(),
				providers: AI_PROVIDERS,
			});
		}
		const flow = FLOW_PATH.exec(path);
		if (flow?.[1]) {
			return json(this.accounts.oauthStatus(flow[1]));
		}
		const models = MODELS_PATH.exec(path);
		if (models?.[1]) {
			return json(
				await this.inference.models(
					decodeURIComponent(models[1]),
					request.signal
				)
			);
		}
		if (path === "/v1/models") {
			// A static catalogue is deliberate: listing the gateway does not spend account quota or refresh a session.
			const accounts = await this.accounts.list();
			return json({
				data: accounts.flatMap((account) =>
					(
						AI_PROVIDERS.find((entry) => entry.id === account.provider)
							?.models ?? []
					).map((model) => ({
						account_id: account.id,
						id: `${account.id}/${model.id}`,
						name: model.name,
						object: "model",
						owned_by: account.provider,
					}))
				),
				object: "list",
				source: "catalog",
			});
		}
		return json({ error: "AI endpoint не найден." }, 404);
	}

	private async post(
		request: Request,
		path: string,
		origin: string
	): Promise<Response> {
		if (path === "/api/ai/oauth/start") {
			const data = parse(providerSchema, await body(request));
			return json(
				await this.accounts.startOAuth(data.provider, origin, data.accountId)
			);
		}
		const complete = COMPLETE_PATH.exec(path);
		if (complete?.[1]) {
			const data = parse(codeSchema, await body(request));
			this.accounts.oauthStatus(complete[1]);
			await this.accounts.completeOAuth(complete[1], data.code);
			return json({ ok: true });
		}
		if (path === "/api/ai/import") {
			const data = parse(providerSchema, await body(request));
			await this.accounts.import(data.provider);
			return json({ ok: true });
		}
		const disconnect = DISCONNECT_PATH.exec(path);
		if (disconnect?.[1]) {
			await this.accounts.disconnect(decodeURIComponent(disconnect[1]));
			return json({ ok: true });
		}
		if (path === "/api/ai/chat") {
			return this.inference.chat(
				(await body(request)) as Parameters<AiInference["chat"]>[0],
				request.signal
			);
		}
		if (
			path === "/v1/chat/completions" ||
			path === "/v1/responses" ||
			path === "/v1/messages"
		) {
			const data = record(await body(request));
			const selected = await this.selectAccount(request, data, path);
			return this.inference.gateway(
				path,
				selected.data,
				selected.id,
				request.signal
			);
		}
		return json({ error: "AI endpoint не найден." }, 404);
	}

	private async selectAccount(
		request: Request,
		data: Record<string, unknown>,
		path: string
	): Promise<{ id: string; data: Record<string, unknown> }> {
		const accounts = await this.accounts.list();
		const model = typeof data.model === "string" ? data.model : "";
		const slash = model.indexOf("/");
		const prefixed = slash > 0 ? model.slice(0, slash) : undefined;
		const header = request.headers.get("x-devhub-account") ?? undefined;
		if (prefixed && header && prefixed !== header) {
			throw new AiError("Аккаунт в model и x-devhub-account различается.", 400);
		}
		const selected = prefixed ?? header;
		const provider = (
			{ "/v1/messages": "claude", "/v1/responses": "codex" } as Record<
				string,
				string
			>
		)[path];
		const candidates = accounts.filter(
			(entry) =>
				(!selected || entry.id === selected) &&
				(!provider || entry.provider === provider)
		);
		if (candidates.length !== 1 || !candidates[0]) {
			throw new AiError(
				"Выберите подключение: model=accountId/model или заголовок x-devhub-account.",
				400
			);
		}
		return {
			data: { ...data, model: prefixed ? model.slice(slash + 1) : data.model },
			id: candidates[0].id,
		};
	}
}

export async function oauthCallback(
	accounts: AiAccounts,
	request: Request,
	local: boolean
): Promise<Response> {
	if (!local) {
		return json(
			{ error: "OAuth callback доступен только на адресе DevHub." },
			403
		);
	}
	let message =
		"Аккаунт подключён. Вернитесь в DevHub; эту вкладку можно закрыть.";
	let status = 200;
	try {
		await accounts.callback(new URL(request.url));
	} catch (error) {
		const safe = safeAiError(error);
		({ error: message, status } = safe);
	}
	const escaped = message.replace(
		HTML_SPECIAL,
		(character) =>
			({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ??
			""
	);
	return new Response(
		encoder.encode(
			`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>DevHub — подключение</title><body><h1>DevHub</h1><p>${escaped}</p><a href="/#/ai">Вернуться в DevHub</a></body></html>`
		),
		{
			headers: {
				"Cache-Control": "no-store",
				"Content-Security-Policy":
					"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
				"Content-Type": "text/html; charset=utf-8",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			},
			status,
		}
	);
}
