import { z } from "zod";

import type { AiAccounts } from "./accounts";
import {
	AI_PROVIDERS,
	type AiInference,
	type AiLifecycleEvent,
	AiUpstreamError,
} from "./inference";
import { AiProxyKeys, createKeySchema } from "./keys";
import { AiModels } from "./models";
import { type AiLease, AiPool, AiPoolError, type AiRoute } from "./pool";
import { accountConfigSchema, proxyConfigSchema } from "./store";
import {
	AiError,
	type AiProvider,
	type AiProxyKey,
	safeAiError,
} from "./types";

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
const CONFIG_PATH = /^\/api\/ai\/accounts\/([^/]+)\/config$/;
const REVOKE_PATH = /^\/api\/ai\/proxy\/keys\/([^/]+)\/revoke$/;
const HTML_SPECIAL = /[&<>"]/g;
const encoder = new TextEncoder();
const PATH_PROVIDER: Record<string, AiProvider | undefined> = {
	"/v1/messages": "claude",
	"/v1/responses": "codex",
};

function errorResponse(error: unknown, path: string): Response {
	const safe = safeAiError(error);
	const gateway = path.startsWith("/v1/");
	const errorTypes: Record<number, string> = {
		401: "authentication_error",
		429: "rate_limit_error",
	};
	const response = json(
		gateway
			? {
					...(path === "/v1/messages" ? { type: "error" } : {}),
					error: {
						code: `devhub_${safe.status}`,
						message: safe.error,
						type: errorTypes[safe.status] ?? "invalid_request_error",
					},
				}
			: { error: safe.error },
		safe.status
	);
	if (safe.status === 401) {
		response.headers.set("WWW-Authenticate", "Bearer");
	}
	const retryAfter =
		error instanceof AiPoolError || error instanceof AiUpstreamError
			? error.retryAfterMs
			: undefined;
	if (safe.status === 429) {
		response.headers.set(
			"Retry-After",
			String(Math.max(1, Math.ceil((retryAfter ?? 60_000) / 1000)))
		);
	}
	return response;
}

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
	private readonly keys: AiProxyKeys;
	private readonly pool: AiPool;
	private readonly models: AiModels;
	constructor(accounts: AiAccounts, inference: AiInference) {
		this.accounts = accounts;
		this.inference = inference;
		this.keys = new AiProxyKeys(accounts.store);
		this.models = new AiModels(accounts.store, inference);
		this.pool = new AiPool(accounts.store, Date.now, (account, model) =>
			this.models.supports(account, model)
		);
	}

	async handle(
		request: Request,
		authorized: boolean,
		origin: string,
		ready: boolean,
		local = authorized
	): Promise<Response> {
		const path = new URL(request.url).pathname;
		const gateway = path.startsWith("/v1/");
		if (!authorized && (!(gateway && local) || request.headers.has("origin"))) {
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
			let key: AiProxyKey | undefined;
			if (
				gateway &&
				(!authorized ||
					request.headers.has("authorization") ||
					request.headers.has("x-api-key"))
			) {
				key = await this.keys.authenticate(request);
			}
			if (request.method === "GET") {
				return await this.get(request, path, key);
			}
			if (request.method === "POST") {
				return await this.post(request, path, origin, key);
			}
			return json({ error: "Метод не поддерживается." }, 405);
		} catch (error) {
			return errorResponse(error, path);
		}
	}

	private async get(
		request: Request,
		path: string,
		key?: AiProxyKey
	): Promise<Response> {
		if (path === "/api/ai/state") {
			return json({
				accounts: await this.pool.views(await this.accounts.list()),
				providers: AI_PROVIDERS,
				proxy: {
					...(await this.accounts.store.proxyConfig()),
					keys: await this.keys.list(),
					stats: this.pool.stats(),
				},
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
		if (path === "/api/ai/models" || path === "/v1/models") {
			const refresh = new URL(request.url).searchParams.get("refresh");
			if (refresh !== null && refresh !== "0" && refresh !== "1") {
				throw new AiError("refresh должен быть 0 или 1.", 400);
			}
			const inventory = await this.models.inventory(
				key,
				refresh === "1",
				request.signal
			);
			if (path === "/api/ai/models") {
				return json(inventory);
			}
			return json({
				data: inventory.models
					.filter((model) => model.available)
					.map((model) => ({
						account_ids: model.accountIds,
						created: 0,
						id: model.id,
						name: model.name,
						object: "model",
						owned_by: model.provider,
						source: model.source,
					})),
				object: "list",
				source: "discovery",
				updated_at: inventory.updatedAt,
			});
		}
		return json({ error: "AI endpoint не найден." }, 404);
	}

	private async proxyManagement(
		request: Request,
		path: string
	): Promise<Response | undefined> {
		const config = CONFIG_PATH.exec(path);
		if (config?.[1]) {
			await this.accounts.store.configureAccount(
				decodeURIComponent(config[1]),
				parse(accountConfigSchema, await body(request))
			);
			return json({ ok: true });
		}
		if (path === "/api/ai/proxy/config") {
			const data = parse(proxyConfigSchema, await body(request));
			const accounts = await this.accounts.store.list();
			for (const alias of data.aliases) {
				if (
					alias.accountId &&
					!accounts.some(
						(account) =>
							account.id === alias.accountId &&
							account.provider === alias.provider
					)
				) {
					throw new AiError(
						"Аккаунт маршрута не соответствует провайдеру.",
						400
					);
				}
			}
			await this.accounts.store.configureProxy(data);
			return json({ ok: true });
		}
		if (path === "/api/ai/proxy/keys") {
			return json(
				await this.keys.create(parse(createKeySchema, await body(request)))
			);
		}
		const revoke = REVOKE_PATH.exec(path);
		if (revoke?.[1]) {
			await this.keys.revoke(decodeURIComponent(revoke[1]));
			return json({ ok: true });
		}
		return undefined;
	}

	private async post(
		request: Request,
		path: string,
		origin: string,
		key?: AiProxyKey
	): Promise<Response> {
		const management = await this.proxyManagement(request, path);
		if (management) {
			return management;
		}
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
			return this.chat(request);
		}
		if (
			path === "/v1/chat/completions" ||
			path === "/v1/responses" ||
			path === "/v1/messages"
		) {
			const data = record(await body(request));
			const route = await this.pool.route(
				data.model,
				PATH_PROVIDER[path],
				request.headers.get("x-devhub-account") ?? undefined,
				key
			);
			return this.dispatch(request, data, path, route, key);
		}
		return json({ error: "AI endpoint не найден." }, 404);
	}

	private async chat(request: Request): Promise<Response> {
		const data = record(await body(request));
		if (
			data.accountId !== undefined &&
			(typeof data.accountId !== "string" ||
				!data.accountId ||
				data.accountId.length > 200)
		) {
			throw new AiError("Некорректное подключение.", 400);
		}
		if (
			data.provider !== undefined &&
			data.provider !== "codex" &&
			data.provider !== "claude"
		) {
			throw new AiError("Неизвестный провайдер.", 400);
		}
		const route = await this.pool.route(
			data.model,
			data.provider as AiProvider | undefined,
			typeof data.accountId === "string" ? data.accountId : undefined
		);
		return this.dispatch(request, data, "/api/ai/chat", route);
	}

	private async infer(
		request: Request,
		data: Record<string, unknown>,
		path: string,
		route: AiRoute,
		lease: AiLease
	): Promise<Response> {
		const input: Record<string, unknown> = {
			...Object.fromEntries(
				Object.entries(data).filter(([name]) => name !== "provider")
			),
			model: route.model,
		};
		const response =
			path === "/api/ai/chat"
				? await this.inference.chat(
						{ ...input, accountId: lease.accountId } as Parameters<
							AiInference["chat"]
						>[0],
						request.signal,
						(event) => this.finish(lease, event)
					)
				: await this.inference.gateway(
						path as "/v1/chat/completions" | "/v1/responses" | "/v1/messages",
						input,
						lease.accountId,
						request.signal,
						(event) => this.finish(lease, event)
					);
		response.headers.set("x-devhub-account", lease.accountId);
		response.headers.set("x-devhub-provider", route.provider);
		response.headers.set("x-devhub-model", route.model);
		return path === "/api/ai/chat"
			? routeResponse(response, lease.accountId, route)
			: response;
	}

	private finish(lease: AiLease, event: AiLifecycleEvent): void {
		lease.finish(event);
		if (event.status === 401 || event.status === 403) {
			this.models.invalidate(lease.accountId, event.credentialFingerprint);
		}
	}

	private async dispatch(
		request: Request,
		data: Record<string, unknown>,
		path: string,
		route: AiRoute,
		key?: AiProxyKey
	): Promise<Response> {
		const excluded = new Set<string>();
		let rejection: AiUpstreamError | undefined;
		while (excluded.size < 32) {
			request.signal.throwIfAborted();
			let lease: AiLease;
			try {
				// biome-ignore lint/performance/noAwaitInLoops: Each failover requires the previous explicit upstream rejection.
				lease = await this.pool.acquire(
					route,
					excluded,
					request.headers.get("x-devhub-session") ?? undefined,
					key
				);
			} catch (error) {
				throw rejection ?? error;
			}
			try {
				return await this.infer(request, data, path, route, lease);
			} catch (error) {
				const upstream = error instanceof AiUpstreamError ? error : undefined;
				this.finish(lease, {
					code: upstream?.code,
					credentialFingerprint: upstream?.credentialFingerprint,
					kind: request.signal.aborted ? "cancel" : "error",
					retryAfterMs: upstream?.retryAfterMs,
					status: upstream?.upstreamStatus ?? safeAiError(error).status,
				});
				if (!upstream?.retryable || route.accountId || request.signal.aborted) {
					throw error;
				}
				excluded.add(lease.accountId);
				rejection = upstream;
			}
		}
		throw (
			rejection ??
			new AiError("Не удалось выполнить запрос через пул подписок.", 429)
		);
	}
}

function routeResponse(
	response: Response,
	accountId: string,
	route: AiRoute
): Response {
	const reader = response.body?.getReader();
	let first = true;
	return new Response(
		new ReadableStream<Uint8Array>({
			cancel: async (reason) => {
				await reader?.cancel(reason);
			},
			pull: async (controller) => {
				if (first) {
					first = false;
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({ accountId, model: route.model, provider: route.provider, type: "route" })}\n`
						)
					);
					return;
				}
				const chunk = await reader?.read();
				if (!chunk || chunk.done) {
					controller.close();
					reader?.releaseLock();
				} else {
					controller.enqueue(chunk.value);
				}
			},
		}),
		{ headers: response.headers, status: response.status }
	);
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
