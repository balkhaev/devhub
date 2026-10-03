import { existsSync } from "node:fs";

import { type Ran, run } from "./probes";

/**
 * Docker Compose projects on this computer (databases, caches, browsers the dev servers use, whole apps): which
 * exist, which of their containers run and how healthy they are, which ones the catalogue's projects use and
 * whether what those need is up; starting and stopping a project.
 */

export interface ContainerView {
	/** How a container that ended ended: 0 is a one-off job that did its work. */
	exitCode: number | null;
	health: "healthy" | "unhealthy" | "starting" | null;
	name: string;
	ports: string;
	running: boolean;
	service: string;
	status: string;
}

export interface ComposeView {
	containers: ContainerView[];
	/** The compose file, when it still exists. */
	file: string | null;
	name: string;
	/** Additional configured dev Compose files, applied after the primary file. */
	overrides?: string[];
	/** The catalogue project that uses it. */
	project: string | null;
	/** Everything the dev servers need from it runs, and nothing of that is unhealthy or still starting. */
	ready: boolean;
	status: string;
	/** The compose services the dev servers need; all of them when empty. */
	wanted: string[];
}

export interface DockerView {
	/** Docker answers at all. */
	available: boolean;
	projects: ComposeView[];
}

/** A compose project a catalogue project uses. */
export interface ComposeConfig {
	/** The compose file, or null when it is not there. */
	file: string | null;
	name: string;
	overrides?: string[];
	project: string;
	wanted: string[];
}

/** Docker refused an action; `port` is the host port it could not take, when that was the reason. */
export class DockerError extends Error {
	readonly port: number | null;

	constructor(message: string, port: number | null) {
		super(message);
		this.port = port;
	}
}

const LINE_BREAK = /\r?\n/;
const HEALTH = /\((healthy|unhealthy|health: starting)\)/;
const EXITED = /^Exited \((\d+)\)/;
const PORT_TAKEN = [
	/Bind for \S*:(\d+) failed: port is already allocated/,
	/exposing port TCP \S*:(\d+)/,
	/listen tcp\S*:(\d+): bind/,
];
/** How Docker says its engine is not running, across versions. */
const NO_DOCKER =
	/error during connect|Cannot connect to the Docker daemon|failed to connect to the docker API|daemon is running|docker_engine|dockerDesktopLinuxEngine/i;

const jsonLines = (text: string): Record<string, unknown>[] =>
	text
		.split(LINE_BREAK)
		.filter((line) => line.trim().startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});

function healthOf(status: string): ContainerView["health"] {
	const match = HEALTH.exec(status)?.[1];
	if (match === "health: starting") {
		return "starting";
	}
	return (match as ContainerView["health"]) ?? null;
}

function labelOf(labels: string, name: string): string {
	for (const pair of labels.split(",")) {
		const at = pair.indexOf("=");
		if (pair.slice(0, at) === name) {
			return pair.slice(at + 1);
		}
	}
	return "";
}

const fine = (container: ContainerView): boolean =>
	container.running &&
	container.health !== "unhealthy" &&
	container.health !== "starting";

/** Whether the containers a project's dev servers need all run well (all of them when none are named). */
export function readyOf(
	containers: readonly ContainerView[],
	wanted: readonly string[]
): boolean {
	if (wanted.length > 0) {
		return wanted.every((service) =>
			containers.some(
				(container) => container.service === service && fine(container)
			)
		);
	}
	// A one-off job (a migration) that finished well does not make its project down.
	return (
		containers.length > 0 &&
		containers.every((container) => fine(container) || container.exitCode === 0)
	);
}

/** Compose projects as `docker compose ls` and `docker ps` print them. */
export function parseDocker(lsText: string, psText: string): ComposeView[] {
	let listed: Record<string, unknown>[] = [];
	try {
		listed = JSON.parse(lsText || "[]") as Record<string, unknown>[];
	} catch {
		listed = [];
	}
	const containers = jsonLines(psText);
	return listed.map((entry): ComposeView => {
		const name = String(entry.Name ?? "");
		const file = String(entry.ConfigFiles ?? "").split(",")[0] ?? "";
		const own = containers
			.filter(
				(container) =>
					labelOf(
						String(container.Labels ?? ""),
						"com.docker.compose.project"
					) === name
			)
			.map((container): ContainerView => {
				const status = String(container.Status ?? "");
				const exited = EXITED.exec(status)?.[1];
				return {
					exitCode: exited === undefined ? null : Number(exited),
					health: healthOf(status),
					name: String(container.Names ?? ""),
					ports: String(container.Ports ?? ""),
					running: String(container.State ?? "") === "running",
					service: labelOf(
						String(container.Labels ?? ""),
						"com.docker.compose.service"
					),
					status,
				};
			});
		return {
			containers: own,
			file: file || null,
			name,
			project: null,
			ready: readyOf(own, []),
			status: String(entry.Status ?? ""),
			wanted: [],
		};
	});
}

export async function dockerView(): Promise<DockerView> {
	const [ls, ps] = await Promise.all([
		run("docker", ["compose", "ls", "-a", "--format", "json"]),
		run("docker", ["ps", "-a", "--format", "{{json .}}"]),
	]);
	if (ls.code !== 0 && ps.code !== 0) {
		return { available: false, projects: [] };
	}
	const projects = parseDocker(ls.out, ps.out).map((project) => ({
		...project,
		file: project.file && existsSync(project.file) ? project.file : null,
	}));
	return { available: true, projects };
}

/**
 * Docker's projects with the catalogue's: which catalogue project uses each and what it needs from it, and the
 * catalogue's compose projects that Docker has not created yet (never brought up), so they can be.
 */
export function withCatalogue(
	projects: readonly ComposeView[],
	configured: readonly ComposeConfig[]
): ComposeView[] {
	const merged = projects.map((project): ComposeView => {
		const config = configured.find((entry) => entry.name === project.name);
		if (!config) {
			return project;
		}
		return {
			...project,
			file: config.file,
			overrides: config.overrides ?? [],
			project: config.project,
			ready: readyOf(project.containers, config.wanted),
			wanted: config.wanted,
		};
	});
	for (const config of configured) {
		if (!merged.some((project) => project.name === config.name)) {
			merged.push({
				containers: [],
				file: config.file,
				name: config.name,
				overrides: config.overrides ?? [],
				project: config.project,
				ready: false,
				status: "",
				wanted: config.wanted,
			});
		}
	}
	return merged;
}

/** What Docker said when it refused, in words; the port it could not take, when that was it. */
export function dockerError(name: string, ran: Ran): DockerError {
	const text = `${ran.err}\n${ran.out}`;
	for (const pattern of PORT_TAKEN) {
		const port = pattern.exec(text)?.[1];
		if (port) {
			return new DockerError(
				`Docker ${name}: порт ${port} уже занят`,
				Number(port)
			);
		}
	}
	if (NO_DOCKER.test(text)) {
		return new DockerError(
			"Docker не отвечает: запустите Docker Desktop",
			null
		);
	}
	const last =
		text
			.split(LINE_BREAK)
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? `код ${ran.code}`;
	return new DockerError(`Docker ${name} не справился: ${last}`, null);
}

/** Brings up what a project's dev servers need (creating what is missing), or stops all its containers. */
export function composeArguments(
	project: ComposeView,
	action: "up" | "stop"
): string[] {
	if (project.file) {
		const base = [
			"compose",
			"-p",
			project.name,
			"-f",
			project.file,
			...(project.overrides ?? []).flatMap((file) => ["-f", file]),
		];
		return action === "up"
			? [...base, "up", "-d", ...project.wanted]
			: [...base, "stop"];
	}
	const names = project.containers.map((container) => container.name);
	if (names.length === 0) {
		throw new DockerError(
			`у проекта Docker ${project.name} нет ни файла, ни контейнеров`,
			null
		);
	}
	return [action === "up" ? "start" : "stop", ...names];
}

export async function composeAction(
	project: ComposeView,
	action: "up" | "stop"
): Promise<void> {
	const ran = await run(
		"docker",
		composeArguments(project, action),
		project.file ? 180_000 : 120_000
	);
	if (ran.code !== 0) {
		throw dockerError(project.name, ran);
	}
}
