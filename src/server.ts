import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { serve, spawn } from "bun";

import page from "./app/index.html";
import { appViewOwner, appViewRefusal } from "./app-view";
import { primaryCheckout, sameSourcePath } from "./checkouts";
import { authenticatedClient, clientToken } from "./client";
import { type Catalogue, loadCatalogue } from "./config";
import { Coolify, CoolifyError } from "./coolify";
import {
	type CreateRequest,
	ProjectCreator,
	registerCreationFolder,
} from "./create";
import { Hub, type HubRuntime, type HubView } from "./hub";
import { frameable } from "./probes";
import { Projects } from "./projects";
import { Queue, QueueError } from "./queue";
import { StageProject } from "./stage";
import { holderWords, type MachineTidy } from "./tidy-words";

/**
 * The hub's server, on 127.0.0.1 only: the page, the state of every service (and its changes as server-sent
 * events), a service's log as it grows, and the actions (start, stop, restart a service or a whole project, bring a
 * compose project up or down). It also passes the shared queue's state and its owner's commands between the queue
 * and the two places they are given: the page and the tray. It answers only requests addressed to itself (a site
 * renamed to 127.0.0.1 cannot read it), and takes actions only from its own page and its own local clients.
 */

const ROOT = resolve(dirname(import.meta.dir));
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/;
const LOG_POLL_MS = 700;
const PING_MS = 15_000;
/** How often the hub removes leftover folders nobody used for a day. */
const IDLE_SWEEP_MS = 60 * 60 * 1000;
const encoder = new TextEncoder();

const json = (value: unknown, status = 200) => Response.json(value, { status });

const ACTION_WORDS: Record<string, string> = {
	create: "создать проект",
	delete: "удалить с диска",
	"delete-plan": "проверить удаление",
	mode: "изменить режим",
	restart: "перезапустить",
	start: "запустить",
	stop: "остановить",
	tidy: "убрать слитые ветки, записи без папок и пустые папки",
	up: "поднять",
};
const TARGET_WORDS: Record<string, string> = {
	docker: "Docker ",
	projects: "проект ",
	services: "",
};
const QUEUE_WORDS: Record<string, string> = {
	continue: "продолжить",
	pause: "пауза",
	resume: "снять паузу",
	stop: "остановить",
};
const EXECUTOR_WORDS: Record<string, string> = {
	"accept-off": "не принимать заказы при запуске",
	"accept-on": "принимать заказы при запуске",
	enable: "включить приём",
	pause: "пауза",
	stop: "остановить",
};

/** The shared queue's actions: `/api/queue/stop` → «очередь: остановить», and the same for one of its executors. */
function queueWords(rest: string[]): string {
	const action = rest.at(-1) ?? "";
	const [scope, id] = rest;
	return rest.length === 3 && scope === "executors"
		? `исполнитель ${id}: ${EXECUTOR_WORDS[action] ?? action}`
		: `очередь: ${QUEUE_WORDS[action] ?? action}`;
}

/** An action's address in words: `/api/docker/gameradar/stop` → «Docker gameradar: остановить». */
export function actionWords(path: string): string {
	const [kind = "", ...rest] = path.split("/").slice(2);
	if (rest.length === 0) {
		return ACTION_WORDS[kind] ?? kind;
	}
	if (kind === "queue") {
		return queueWords(rest);
	}
	const action = rest.at(-1) ?? "";
	const target = rest.slice(0, -1).join("/");
	return `${TARGET_WORDS[kind] ?? ""}${target}: ${ACTION_WORDS[action] ?? action}`;
}

/** Every action taken from the page, with its outcome: printed, and kept in `.logs/actions.log`. */
function journal(line: string, root = ROOT): void {
	const entry = `${new Date().toLocaleString("ru-RU")} · ${line}\n`;
	process.stdout.write(entry);
	mkdir(join(root, ".logs"), { recursive: true })
		.then(() => appendFile(join(root, ".logs", "actions.log"), entry))
		.catch(() => undefined);
}

function sse(
	request: Request,
	start: (send: (data: unknown) => void) => () => void
): Response {
	let stop: () => void = () => undefined;
	const body = new ReadableStream<Uint8Array>({
		cancel: () => stop(),
		start: (controller) => {
			const send = (data: unknown) => {
				try {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
					);
				} catch {
					stop();
				}
			};
			const ping = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					stop();
				}
			}, PING_MS);
			const release = start(send);
			stop = () => {
				clearInterval(ping);
				release();
			};
		},
	});
	request.signal.addEventListener("abort", () => stop());
	return new Response(body, {
		headers: {
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Content-Type": "text/event-stream",
		},
	});
}

export async function startHub(
	options: {
		catalogue?: Catalogue;
		coolify?: Coolify;
		creator?: ProjectCreator;
		dev?: boolean;
		/** How often leftover folders nobody used for a day are removed; never when it is not given. */
		idleSweepMs?: number;
		port?: number;
		queue?: Queue;
		root?: string;
		runtime?: HubRuntime;
	} = {}
) {
	const root = options.root ?? ROOT;
	const catalogue =
		options.catalogue ?? (await loadCatalogue(join(root, "services.json")));
	const token = await clientToken(root);
	const hub = new Hub(catalogue, root, options.runtime);
	const projects = new Projects(hub, root);
	const coolify = options.coolify ?? new Coolify(() => hub.configuration);
	const queue = options.queue ?? new Queue(() => hub.configuration);
	const creator =
		options.creator ??
		new ProjectCreator({
			catalogue: () => hub.configuration,
			hubRoot: primaryCheckout(root),
			registered: async (folder) => {
				registerCreationFolder(join(root, "services.json"), folder);
				await hub.replaceCatalogue(
					await loadCatalogue(join(root, "services.json"))
				);
			},
		});
	const changeProjectMode = async (request: Request, id: string) => {
		const body: unknown = await request.json();
		if (
			!body ||
			typeof body !== "object" ||
			!("mode" in body) ||
			(body.mode !== "mvp" && body.mode !== "prod")
		) {
			throw new Error("Нужен режим mvp или prod");
		}
		const project = hub.current.projects.find((entry) => entry.id === id);
		if (!project) {
			throw new Error(`нет проекта ${id}`);
		}
		const { mode } = body;
		const stage = new StageProject(project.path);
		stage.withLock(() => stage.setMode(mode));
		await hub.refresh();
		return {
			integrationBranch: stage.integrationBranch,
			mode: stage.policy.mode,
			releaseBranch: stage.policy.releaseBranch,
		};
	};
	/** Git inspection of every checkout takes seconds: it runs beside the hub, not inside its event loop. */
	const tidy = async (...flags: string[]): Promise<MachineTidy> => {
		const child = spawn(
			[
				process.execPath,
				join(ROOT, "src", "cli.ts"),
				"tidy",
				"--json",
				...flags,
			],
			{ stderr: "pipe", stdout: "pipe", windowsHide: true }
		);
		const [text, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) {
			throw new Error(error.trim() || `tidy завершился с кодом ${code}`);
		}
		return JSON.parse(text) as MachineTidy;
	};
	let ready = false;
	const port = options.port ?? catalogue.port;
	let origin = `http://127.0.0.1:${port}`;

	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	/** Addressed to the hub itself, not to another name that happens to lead to 127.0.0.1. */
	const local = (request: Request): boolean =>
		hosts.has(request.headers.get("host") ?? "");

	/** Actions only from the hub's own page: another site cannot make this computer start or stop servers. */
	const allowed = (request: Request): boolean => {
		if (!local(request)) {
			return false;
		}
		if (authenticatedClient(request, token)) {
			return true;
		}
		let from = request.headers.get("origin");
		if (
			!from &&
			request.method === "GET" &&
			request.headers.get("sec-fetch-site") === "same-origin"
		) {
			try {
				from = new URL(request.headers.get("referer") ?? "").origin;
			} catch {
				return false;
			}
		}
		const fromHost =
			from === origin || from === `http://localhost:${new URL(origin).port}`;
		return (
			local(request) && fromHost && request.headers.get("x-devhub") === "1"
		);
	};

	const refused = () =>
		json({ error: "Пульт отвечает только на своём адресе" }, 403);

	/** Reads from the hub's own page or CLI only: production state and logs are not for other sites. */
	const guarded = async (
		request: Request,
		work: () => Promise<unknown>
	): Promise<Response> => {
		if (!allowed(request)) {
			return json({ error: "Доступно только со страницы пульта" }, 403);
		}
		try {
			return json(await work());
		} catch (error) {
			const status =
				error instanceof CoolifyError || error instanceof QueueError
					? error.status
					: 409;
			return json({ error: (error as Error).message }, status);
		}
	};

	const act = async (
		request: Request,
		work: () => Promise<unknown>
	): Promise<Response> => {
		if (!allowed(request)) {
			return json(
				{ error: "Действия принимаются только со страницы пульта" },
				403
			);
		}
		if (!ready) {
			return json({ error: "Пульт ещё запускается" }, 503);
		}
		// Dependencies and readiness can take longer than the HTTP idle timeout.
		server.timeout(request, 0);
		const what = actionWords(new URL(request.url).pathname);
		try {
			const result = (await work()) ?? null;
			const failed = Array.isArray(result) ? result.join("; ") : "";
			journal(`${what} — ${failed ? `не всё: ${failed}` : "готово"}`, root);
			return json({ ok: true, result });
		} catch (error) {
			journal(`${what} — не вышло: ${(error as Error).message}`, root);
			return json({ error: (error as Error).message, ok: false }, 409);
		}
	};

	const server = serve({
		development: options.dev ? { console: true, hmr: true } : false,
		fetch: () => new Response("Not found", { status: 404 }),
		hostname: "127.0.0.1",
		idleTimeout: 60,
		port,
		routes: {
			"/": page,
			"/api/create": {
				GET: (request) => guarded(request, async () => creator.list()),
				POST: (request) =>
					act(request, async () => {
						const body = (await request.json()) as Partial<CreateRequest>;
						return creator.start({
							baseDir: body.baseDir,
							description:
								typeof body.description === "string" && body.description.trim()
									? body.description.trim().slice(0, 200)
									: undefined,
							name: String(body.name ?? "").trim(),
							template: body.template as CreateRequest["template"],
							web: body.web !== false,
						});
					}),
			},
			"/api/create/:id": (request) =>
				guarded(request, () => {
					const job = creator.job(request.params.id);
					if (!job) {
						return Promise.reject(new Error("нет такого создания проекта"));
					}
					return Promise.resolve(job);
				}),
			"/api/docker/:name/:action": {
				POST: (request) =>
					act(request, () => {
						const { action, name } = request.params;
						if (action !== "up" && action !== "stop") {
							throw new Error(`неизвестное действие ${action}`);
						}
						return hub.composeAction(name, action);
					}),
			},
			"/api/events": (request, bunServer) => {
				if (!local(request)) {
					return refused();
				}
				bunServer.timeout(request, 0);
				return sse(request, (send) => {
					send(hub.current);
					return hub.subscribe((view: HubView) => send(view));
				});
			},
			"/api/frame": async (request) => {
				if (!local(request)) {
					return refused();
				}
				const url = new URL(request.url).searchParams.get("url") ?? "";
				if (!LOCAL_URL.test(url)) {
					return json({ ok: true, reason: null, sure: true });
				}
				return json(await frameable(url, new URL(request.url).origin));
			},
			/**
			 * Whether the hub runs, for the tray: its process (to stop it) and how many servers it started. Cheap:
			 * it reads nothing from the computer, so asking it often floods no one's log.
			 */
			"/api/health": (request) =>
				local(request)
					? json(
							{
								app: "devhub",
								managed: hub.processes.liveCount(),
								ok: ready,
								pid: process.pid,
							},
							ready ? 200 : 503
						)
					: refused(),
			"/api/prod": (request) =>
				guarded(request, () =>
					coolify.view(new URL(request.url).searchParams.has("refresh"))
				),
			"/api/prod/apps/:uuid/deployments": (request) =>
				guarded(request, () => coolify.deployments(request.params.uuid)),
			"/api/prod/apps/:uuid/logs": (request) =>
				guarded(request, async () => ({
					logs: await coolify.logs(
						request.params.uuid,
						Number(new URL(request.url).searchParams.get("lines") ?? 200)
					),
				})),
			"/api/projects/:id/:action": {
				POST: (request) =>
					act(request, async () => {
						const { action, id } = request.params;
						if (action === "mode") {
							return changeProjectMode(request, id);
						}
						if (action === "delete-plan") {
							return projects.plan(id);
						}
						if (action === "delete") {
							const body: unknown = await request.json();
							if (
								!body ||
								typeof body !== "object" ||
								!("token" in body) ||
								typeof body.token !== "string" ||
								body.token.length > 100
							) {
								throw new Error(
									"Нужен подтверждённый список папок для удаления"
								);
							}
							return projects.delete(id, body.token);
						}
						if (action === "start") {
							return hub.startProject(id);
						}
						if (action === "stop") {
							return hub.stopProject(id);
						}
						throw new Error(`неизвестное действие ${action}`);
					}),
			},
			"/api/queue": {
				GET: (request) =>
					guarded(request, async () => ({ queue: await queue.view() })),
			},
			"/api/queue/:action": {
				POST: (request) => act(request, () => queue.act(request.params.action)),
			},
			"/api/queue/executors/:id/:action": {
				POST: (request) =>
					act(request, () =>
						queue.executor(request.params.id, request.params.action)
					),
			},
			"/api/queue/jobs/:id": {
				GET: (request) =>
					guarded(request, async () => ({
						job: await queue.job(request.params.id),
					})),
			},
			"/api/queue/tray": {
				GET: (request) => guarded(request, () => queue.tray(origin)),
			},
			"/api/services/:project/:service/:action": {
				POST: (request) =>
					act(request, () => {
						const { action, project, service } = request.params;
						const key = `${project}/${service}`;
						if (action === "start") {
							return hub.startService(key);
						}
						if (action === "stop") {
							return hub.stopService(key, !authenticatedClient(request, token));
						}
						if (action === "restart") {
							return hub.restartService(
								key,
								!authenticatedClient(request, token)
							);
						}
						throw new Error(`неизвестное действие ${action}`);
					}),
			},
			"/api/services/:project/:service/log": (request, bunServer) => {
				if (!local(request)) {
					return refused();
				}
				const key = `${request.params.project}/${request.params.service}`;
				const service = hub.service(key);
				if (!service) {
					return json({ error: `нет сервиса ${key}` }, 404);
				}
				bunServer.timeout(request, 0);
				return sse(request, (send) => {
					let offset: number | undefined;
					let reading = false;
					const read = async () => {
						if (reading) {
							return;
						}
						reading = true;
						try {
							const tail = await hub.processes.tail(service, offset);
							if (tail.text || tail.reset) {
								send({ reset: tail.reset, text: tail.text });
							}
							({ offset } = tail);
						} finally {
							reading = false;
						}
					};
					read().catch(() => undefined);
					const timer = setInterval(() => {
						read().catch(() => undefined);
					}, LOG_POLL_MS);
					return () => clearInterval(timer);
				});
			},
			"/api/state": (request) =>
				local(request) ? json(hub.current) : refused(),
			"/api/tidy": {
				GET: (request) => guarded(request, () => tidy()),
				POST: (request) =>
					act(request, async () => {
						// The page asks to end the processes that hold emptied folders with `{ kill: true }`.
						const body = (await request.json().catch(() => null)) as {
							kill?: unknown;
						} | null;
						return tidy("--apply", ...(body?.kill === true ? ["--kill"] : []));
					}),
			},
		},
	});
	// Port zero is useful for isolated endpoint checks; validate the actual bound address.
	origin = `http://127.0.0.1:${server.port}`;
	hub.processes.setFrameOrigin(origin);
	hosts.add(`127.0.0.1:${server.port}`);
	hosts.add(`localhost:${server.port}`);
	// Claim the port before adopting processes: concurrent auto-open attempts have one owner.
	try {
		await hub.start();
		ready = true;
	} catch (error) {
		hub.stop();
		server.stop(true);
		throw error;
	}
	// Services that run whenever the hub does come up beside it: the page and the CLI do not wait for them.
	const wanted = hub.autostartPending();
	if (wanted.length > 0) {
		hub
			.startAutostart()
			.then((errors) => {
				const outcome =
					errors.length > 0 ? `не всё: ${errors.join("; ")}` : "готово";
				journal(`автозапуск (${wanted.join(", ")}) — ${outcome}`, root);
			})
			.catch(() => undefined);
	}
	/** Leftover folders nobody used for a day go by themselves; what went is written to the journal. */
	const sweepIdle = async () => {
		try {
			const report = await tidy("--idle");
			for (const project of report.projects) {
				if (project.applied?.folders.length) {
					const ended = project.applied.ended.length
						? `; завершены процессы: ${holderWords(project.applied.ended)}`
						: "";
					journal(
						`автоуборка ${project.id} — убраны пустые папки: ${project.applied.folders.join(", ")}${ended}`,
						root
					);
				}
			}
		} catch (error) {
			journal(`автоуборка — не вышло: ${(error as Error).message}`, root);
		}
	};
	const sweeping = options.idleSweepMs
		? setInterval(sweepIdle, options.idleSweepMs)
		: undefined;
	return {
		hub,
		stop: () => {
			clearInterval(sweeping);
			hub.stop();
			server.stop(true);
		},
		url: `http://127.0.0.1:${server.port}/`,
	};
}

if (import.meta.main) {
	const primary = primaryCheckout(ROOT);
	if (sameSourcePath(ROOT, primary)) {
		// Every service would inherit an app's private %LOCALAPPDATA% from a hub started inside that app.
		const owner = appViewOwner();
		if (owner) {
			process.stderr.write(
				`${new Date().toLocaleString("ru-RU")} · ${appViewRefusal(owner)}\n`
			);
			process.exit(1);
		}
		const argv = process.argv.slice(2);
		const at = argv.indexOf("--port");
		const hub = await startHub({
			dev: argv.includes("--dev"),
			idleSweepMs: IDLE_SWEEP_MS,
			port: at >= 0 ? Number(argv[at + 1]) : undefined,
		});
		const { projects } = hub.hub.current;
		const services = projects.flatMap((project) => project.services);
		const up = services.filter((service) =>
			["running", "starting", "external"].includes(service.status)
		);
		process.stdout.write(
			`Пульт: ${hub.url} · ${projects.length} проектов, ${services.length} сервисов, работают ${up.length}\n`
		);
	} else {
		const { ensureHub } = await import("./open");
		process.stdout.write(
			`DevHub: worktree делегирует dev в ${primary} · ${await ensureHub()}\n`
		);
	}
}
