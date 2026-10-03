import { dirname, join, resolve } from "node:path";

import { clientToken, requestHub } from "./client";
import {
	type Catalogue,
	canonicalProjectFolder,
	loadCatalogue,
	loadManifest,
	type ProjectConfig,
} from "./config";
import { type HubView, samePath } from "./hub";
import { ensureHub } from "./open";

const ROOT = resolve(dirname(import.meta.dir));
const HELP = `devhub — управление локальной разработкой
  bun run hub list                      список проектов и сервисов
  bun run hub check                     проверить все devhub.json
  bun run hub status                    состояние процессов
  bun run hub start project/service     запустить через пульт
  bun run hub start project             запустить сервисы проекта
  bun run hub stop project[/service]    остановить процессы пульта
  bun run hub restart project/service   перезапустить процесс пульта
  bun run hub start --project PATH --script dev[:name]

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
	json: boolean;
	project?: string;
	script?: string;
	targets: string[];
}

export function parseArguments(args: string[]): Arguments {
	const parsed: Arguments = {
		action: args[0] ?? "help",
		json: false,
		targets: [],
	};
	for (let index = 1; index < args.length; index += 1) {
		const value = args[index] ?? "";
		if (value === "--json") {
			parsed.json = true;
		} else if (value === "--project" || value === "--script") {
			index += 1;
			const next = args[index];
			if (!next || next.startsWith("--")) {
				throw new Error(`после ${value} нужно значение`);
			}
			if (value === "--project") {
				parsed.project = next;
			} else {
				parsed.script = next;
			}
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
