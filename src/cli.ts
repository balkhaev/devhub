import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sleep } from "bun";
import { primaryCheckout } from "./checkouts";
import { clientToken, requestHub } from "./client";
import {
	type Catalogue,
	canonicalProjectFolder,
	loadCatalogue,
	loadManifest,
	type ProjectConfig,
} from "./config";
import { Coolify, type ProdProject } from "./coolify";
import type { CreateJob } from "./create";
import { type HubView, samePath } from "./hub";
import { ensureHub } from "./open";

const ROOT = primaryCheckout(resolve(dirname(import.meta.dir)));
const HELP = `devhub — управление локальной разработкой
  bun run hub list                      список проектов и сервисов
  bun run hub check                     проверить все devhub.json
  bun run hub status                    состояние процессов
  bun run hub start project/service     запустить через пульт
  bun run hub start project             запустить сервисы проекта
  bun run hub stop project[/service]    остановить процессы пульта
  bun run hub restart project/service   перезапустить процесс пульта
  bun run hub start --project PATH --script dev[:name]
  bun run hub logs project/service [--lines N]   последние строки лога
  bun run hub attach project/service    запустить и следить за логом (для превью агентов)
  bun run hub create bts|python NAME [--description TEXT] [--no-web]
                                        создать проект и подключить его к пульту
  bun run hub prod [project] [--logs] [--lines N] [--json]
                                        что работает в проде (Coolify)

Проекты хранят dev-команды в devhub.json. Production запускается собственными start/deploy-командами.
`;

export function scriptTargets(
	project: ProjectConfig,
	script: string
): string[] {
	const targets = project.launch[script];
	if (!targets) {
		throw new Error(
			`${project.id}: команда ${script} не зарегистрирована в devhub.json`
		);
	}
	return [
		...new Set(
			targets.map((target) =>
				target.includes("/") ? target : `${project.id}/${target}`
			)
		),
	];
}

interface Arguments {
	action: string;
	description?: string;
	json: boolean;
	lines: number;
	logs: boolean;
	project?: string;
	script?: string;
	targets: string[];
	web: boolean;
}

const DEFAULT_LINES = 80;
const FOLLOW_MS = 700;
const CREATE_POLL_MS = 1000;

const FLAGS: Record<string, (parsed: Arguments) => void> = {
	"--json": (parsed) => {
		parsed.json = true;
	},
	"--logs": (parsed) => {
		parsed.logs = true;
	},
	"--no-web": (parsed) => {
		parsed.web = false;
	},
};
const VALUES: Record<string, (parsed: Arguments, value: string) => void> = {
	"--description": (parsed, value) => {
		parsed.description = value;
	},
	"--lines": (parsed, value) => {
		parsed.lines = Number(value);
		if (!(Number.isInteger(parsed.lines) && parsed.lines > 0)) {
			throw new Error("--lines: положительное число");
		}
	},
	"--project": (parsed, value) => {
		parsed.project = value;
	},
	"--script": (parsed, value) => {
		parsed.script = value;
	},
};

export function parseArguments(args: string[]): Arguments {
	const parsed: Arguments = {
		action: args[0] ?? "help",
		json: false,
		lines: DEFAULT_LINES,
		logs: false,
		targets: [],
		web: true,
	};
	for (let index = 1; index < args.length; index += 1) {
		const value = args[index] ?? "";
		const flag = FLAGS[value];
		const option = VALUES[value];
		if (flag) {
			flag(parsed);
		} else if (option) {
			index += 1;
			const next = args[index];
			if (!next || next.startsWith("--")) {
				throw new Error(`после ${value} нужно значение`);
			}
			option(parsed, next);
		} else if (value.startsWith("-")) {
			throw new Error(
				`неизвестный параметр ${value}; dev-параметры задаются в devhub.json`
			);
		} else {
			parsed.targets.push(value);
		}
	}
	validateRouting(parsed);
	return parsed;
}

function validateRouting(parsed: Arguments): void {
	if (Boolean(parsed.project) !== Boolean(parsed.script)) {
		throw new Error("--project и --script нужно задавать вместе");
	}
	if (parsed.project && parsed.targets.length) {
		throw new Error("укажите сервисы либо --project/--script");
	}
}

function printCatalogue(catalogue: Catalogue, options: Arguments): void {
	if (options.json) {
		process.stdout.write(`${JSON.stringify(catalogue, null, 2)}\n`);
	} else if (options.action === "check") {
		process.stdout.write(
			`Каталог исправен: ${catalogue.projects.length} проектов, ${catalogue.projects.reduce((count, project) => count + project.services.length, 0)} сервисов\n`
		);
	} else {
		for (const project of catalogue.projects) {
			process.stdout.write(`${project.id} · ${project.path}\n`);
			for (const service of project.services) {
				process.stdout.write(
					`  ${project.id}/${service.id}${service.port ? ` :${service.port}` : ""} · ${service.command ?? "подчинённый сервис"}\n`
				);
			}
		}
	}
}

export async function resolveTargets(
	catalogue: Catalogue,
	options: Arguments
): Promise<string[]> {
	let { targets } = options;
	if (options.project && options.script) {
		const manifest = await loadManifest(
			canonicalProjectFolder(catalogue, options.project)
		);
		const known = catalogue.projects.find(
			(project) => project.id === manifest.id
		);
		if (
			!(
				known &&
				samePath(
					// biome-ignore lint/suspicious/noTemplateCurlyInString: machine catalogue placeholder
					resolve(known.path.replaceAll("${code}", catalogue.code)),
					manifest.path
				)
			)
		) {
			throw new Error(
				`${manifest.path} не зарегистрирован: добавьте его родительскую папку в discover в ${join(ROOT, "services.json")}`
			);
		}
		// Worktree manifests may have old project ids or old launch maps; the stage owns both.
		targets = scriptTargets(known, options.script);
	}
	if (options.action !== "status" && targets.length === 0) {
		throw new Error("укажите проект или проект/сервис");
	}
	validateTargets(catalogue, targets, options.action);
	return targets;
}

function validateTargets(
	catalogue: Catalogue,
	targets: string[],
	action: string
): void {
	for (const target of targets) {
		const [projectId, serviceId, extra] = target.split("/");
		const project = catalogue.projects.find((entry) => entry.id === projectId);
		if (
			!project ||
			extra ||
			(serviceId &&
				!project.services.some((service) => service.id === serviceId))
		) {
			throw new Error(`нет проекта или сервиса ${target}`);
		}
		if (action === "restart" && !serviceId) {
			throw new Error("для restart укажите проект/сервис");
		}
	}
}

function printStatus(state: HubView, asJson: boolean): void {
	if (asJson) {
		process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
	} else {
		for (const service of state.projects.flatMap(
			(project) => project.services
		)) {
			process.stdout.write(
				`${service.key}\t${service.status}${service.pid ? `\tPID ${service.pid}` : ""}\n`
			);
		}
	}
}

const logFile = (target: string): string =>
	join(ROOT, ".logs", `${target.replace("/", "-")}.log`);

/** The last `count` lines of a service's log. */
export async function lastLines(file: string, count: number): Promise<string> {
	if (!existsSync(file)) {
		return "";
	}
	const { size } = await stat(file);
	const length = Math.min(size, Math.max(64 * 1024, count * 400));
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n");
		if (length < size) {
			lines.shift();
		}
		if (lines.at(-1) === "") {
			lines.pop();
		}
		return lines.slice(-count).join("\n");
	} finally {
		await handle.close();
	}
}

function serviceTarget(options: Arguments): string {
	const [target] = options.targets;
	if (!target?.includes("/") || options.targets.length > 1) {
		throw new Error(`${options.action}: укажите один проект/сервис`);
	}
	return target;
}

/** Follow the log for the browser pane of an agent: the service itself stays DevHub's. */
async function follow(target: string, lines: number): Promise<never> {
	const file = logFile(target);
	const tail = await lastLines(file, lines);
	if (tail) {
		process.stdout.write(`${tail}\n`);
	}
	let offset = existsSync(file) ? (await stat(file)).size : 0;
	for (;;) {
		// biome-ignore lint/performance/noAwaitInLoops: one log file followed in order
		await sleep(FOLLOW_MS);
		if (!existsSync(file)) {
			continue;
		}
		const { size } = await stat(file);
		if (size < offset) {
			offset = 0;
		}
		if (size > offset) {
			const handle = await open(file, "r");
			try {
				const buffer = Buffer.alloc(size - offset);
				await handle.read(buffer, 0, buffer.length, offset);
				process.stdout.write(buffer);
			} finally {
				await handle.close();
			}
			offset = size;
		}
	}
}

async function hubJson(
	address: string,
	path: string,
	token: string,
	body?: unknown
): Promise<unknown> {
	const response = await fetch(new URL(path, address), {
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
			"x-devhub-client": token,
		},
		method: body === undefined ? "GET" : "POST",
		signal: AbortSignal.timeout(60_000),
	});
	const result = (await response.json()) as { error?: string };
	if (!response.ok) {
		throw new Error(result.error ?? `Пульт ответил HTTP ${response.status}`);
	}
	return result;
}

async function create(options: Arguments): Promise<void> {
	const [template, name, extra] = options.targets;
	if (!((template === "bts" || template === "python") && name) || extra) {
		throw new Error("create bts|python NAME");
	}
	const address = await ensureHub();
	const token = await clientToken(ROOT);
	const started = (await hubJson(address, "/api/create", token, {
		description: options.description,
		name,
		template,
		web: options.web,
	})) as { result: CreateJob };
	let shown = 0;
	for (;;) {
		// biome-ignore lint/performance/noAwaitInLoops: one job followed until it ends
		const job = (await hubJson(
			address,
			`/api/create/${started.result.id}`,
			token
		)) as CreateJob;
		process.stdout.write(job.log.slice(shown));
		shown = job.log.length;
		if (job.status === "done") {
			process.stdout.write(
				`${job.path} · ${address}#/projects/${name}/manage\n`
			);
			return;
		}
		if (job.status === "failed") {
			throw new Error(job.error ?? "создание не удалось");
		}
		await sleep(CREATE_POLL_MS);
	}
}

function printProd(project: ProdProject): void {
	process.stdout.write(
		`${project.id} · Coolify: ${project.coolifyProjects.join(", ") || "—"}\n`
	);
	for (const app of project.applications) {
		process.stdout.write(
			`  ${app.name}\t${app.status.raw}\t${app.domains.join(" ") || "без домена"}\t${app.commit?.slice(0, 7) ?? ""}\t${app.uuid}\n`
		);
	}
	for (const resource of project.resources) {
		process.stdout.write(
			`  ${resource.kind}: ${resource.name}\t${resource.status.raw}\n`
		);
	}
}

/** Each application's last deployment and recent log lines. */
async function printLogs(
	coolify: Coolify,
	project: ProdProject,
	lines: number
): Promise<void> {
	for (const app of project.applications) {
		// biome-ignore lint/performance/noAwaitInLoops: printed in order, one application at a time
		const [deployment] = await coolify.deployments(app.uuid, 1);
		process.stdout.write(
			`
== ${app.name}${deployment ? ` · деплой ${deployment.status} ${deployment.createdAt ?? ""} ${deployment.message ?? ""}` : ""}
`
		);
		process.stdout.write(`${await coolify.logs(app.uuid, lines)}
`);
	}
}

async function prod(catalogue: Catalogue, options: Arguments): Promise<void> {
	const coolify = new Coolify(() => catalogue);
	const view = await coolify.view(true);
	if (!view.configured) {
		throw new Error(
			"Coolify не настроен: добавьте coolify.url в services.json"
		);
	}
	if (view.error) {
		throw new Error(view.error);
	}
	const [id] = options.targets;
	const projects = id
		? view.projects.filter((project) => project.id === id)
		: view.projects;
	if (id && !catalogue.projects.some((project) => project.id === id)) {
		throw new Error(`нет проекта ${id}`);
	}
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(id ? (projects[0] ?? null) : view, null, 2)}\n`
		);
		return;
	}
	if (id && projects.length === 0) {
		process.stdout.write(`${id}: в Coolify ничего не найдено\n`);
		return;
	}
	for (const project of projects) {
		printProd(project);
		if (!options.logs) {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: projects are printed in order
		await printLogs(coolify, project, options.lines);
	}
	if (!id && view.unmatched.length) {
		process.stdout.write(
			`без проекта в пульте: ${view.unmatched.map((app) => app.name).join(", ")}\n`
		);
	}
}

async function logs(catalogue: Catalogue, options: Arguments): Promise<void> {
	const target = serviceTarget(options);
	validateTargets(catalogue, [target], options.action);
	process.stdout.write(`${await lastLines(logFile(target), options.lines)}\n`);
}

async function attach(catalogue: Catalogue, options: Arguments): Promise<void> {
	const target = serviceTarget(options);
	validateTargets(catalogue, [target], options.action);
	const address = await ensureHub();
	await requestHub(
		address,
		`/api/services/${target}/start`,
		await clientToken(ROOT),
		true
	);
	process.stdout.write(
		`${target}: работает в DevHub · ${address} · Ctrl+C отключает только этот вывод\n`
	);
	await follow(target, options.lines);
}

/** Commands beyond the process actions: they do not resolve launch targets. */
const COMMANDS: Record<
	string,
	(catalogue: Catalogue, options: Arguments) => Promise<void>
> = {
	attach,
	create: (_catalogue, options) => create(options),
	logs,
	prod,
};

export async function main(args = process.argv.slice(2)): Promise<void> {
	const options = parseArguments(args);
	if (["help", "--help", "-h"].includes(options.action)) {
		process.stdout.write(HELP);
		return;
	}
	const catalogue = await loadCatalogue(join(ROOT, "services.json"));
	if (["list", "check"].includes(options.action)) {
		printCatalogue(catalogue, options);
		return;
	}
	const command = COMMANDS[options.action];
	if (command) {
		return command(catalogue, options);
	}
	if (!["status", "start", "stop", "restart"].includes(options.action)) {
		throw new Error(`неизвестное действие ${options.action}\n${HELP}`);
	}
	const targets = await resolveTargets(catalogue, options);
	const address = await ensureHub();
	const token = await clientToken(ROOT);
	if (options.action === "status") {
		printStatus(
			(await requestHub(address, "/api/state", token)) as HubView,
			options.json
		);
		return;
	}
	for (const target of targets) {
		const path = target.includes("/")
			? `services/${target}`
			: `projects/${target}`;
		// biome-ignore lint/performance/noAwaitInLoops: a launch group starts in dependency order
		await requestHub(address, `/api/${path}/${options.action}`, token, true);
		process.stdout.write(
			`${target}: ${options.action} — готово · ${address}\n`
		);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`devhub: ${(error as Error).message}\n`);
		process.exitCode = 1;
	});
}
