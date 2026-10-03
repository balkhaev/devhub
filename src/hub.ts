import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
	type Catalogue,
	DOCKER_NEED,
	healthUrl,
	type Service,
	servicesOf,
	uiUrl,
} from "./config";
import {
	type ComposeConfig,
	type ComposeView,
	composeAction,
	DockerError,
	type DockerView,
	dockerView,
	withCatalogue,
} from "./docker";
import {
	healthy,
	listeningPorts,
	listeningPortsV6,
	type ProcessInfo,
	processInfo,
} from "./probes";
import { alive, killTree, type Managed, Processes } from "./processes";

/**
 * The hub's picture of this computer, kept current: every catalogued service with its state, who owns each
 * listening port, and Docker. Several services may want one port (five want 3000), so a port a service did not get
 * from the hub is given to the service it really is: the Docker project that publishes it, the checkout its process
 * runs from, or, failing both, the one service whose health page answers. The others on that port are "busy". The
 * hub starts services after what they need (other services, Docker projects), refuses a port another process holds,
 * and stops what it started — or, when asked explicitly, what runs a service elsewhere.
 */

export type ServiceStatus =
	| "stopped"
	| "starting"
	| "running"
	| "unhealthy"
	| "crashed"
	| "external"
	| "busy";

export interface OwnerView {
	/** The folder of the checkout it runs from, when a command line in its process tree tells. */
	checkout: string | null;
	command: string;
	/** The Docker Compose project that publishes the port, when Docker holds it. */
	docker: string | null;
	/** Who it is, in words: «Docker, проект gameradar», «python.exe (PID 4120) из D:\code\predict». */
	label: string;
	name: string;
	pid: number;
}

/** Something a service needs started first, and whether it is up. */
export interface NeedView {
	key: string;
	label: string;
	up: boolean;
}

export interface ServiceView {
	canStart: boolean;
	command: string | null;
	description: string | null;
	/** The checkout it runs from when that is not the one in the catalogue. */
	elsewhere: string | null;
	exit: { at: number; code: number | null } | null;
	health: string | null;
	key: string;
	managed: boolean;
	name: string;
	needs: NeedView[];
	/** Who holds the service's port when the hub did not start it: the service itself elsewhere, or (busy) another. */
	owner: OwnerView | null;
	pid: number | null;
	port: number | null;
	project: string;
	since: number | null;
	status: ServiceStatus;
	ui: { label: string; url: string }[];
	warn: string | null;
	workdir: string;
}

export interface ProjectView {
	description: string | null;
	/** The Docker Compose project its dev servers use. */
	docker: ComposeView | null;
	id: string;
	name: string;
	path: string;
	services: ServiceView[];
}

export interface PortView {
	owner: OwnerView | null;
	port: number;
	/** The catalogued service that holds this port, if any. */
	service: string | null;
}

export interface HubView {
	docker: DockerView;
	/** When this run of the hub began: an open page that sees it change reloads, to get the new version. */
	hub: number;
	ports: PortView[];
	projects: ProjectView[];
	updatedAt: number;
}

const TICK_MS = 2000;
/**
 * Every this many ticks, while a page watches, the hub reads Docker and asks every service's health page again;
 * in between it asks only services that are new on their port or still starting. Health pages are asked no more
 * often than that, so the services' own logs are not flooded; with no page open nothing is asked at all.
 */
const FULL_EVERY = 5;
/** A started service gets this long to open its port and pass its health check before it counts as unhealthy. */
const WARMUP_MS = 120_000;
/** How long a Docker project brought up for a service may take to become healthy. */
const COMPOSE_READY_MS = 90_000;
const PORT_FREE_MS = 15_000;
const NO_PORT_WARMUP_MS = 500;
const START_POLL_MS = 500;
const ANCESTORS = 4;
const WINDOWS_PATH = /[A-Za-z]:[\\/][^"'\s]+/g;
/** Folders inside a checkout its servers run from: environments (.venv, .venv-laya), dependencies, sources. */
const CHECKOUT_END =
	/[\\/](?:\.?venv[^\\/]*|node_modules|Scripts|dist|src|apps|packages)(?:[\\/]|$)/i;
const TRAILING_SLASH = /\\$/;
const PUBLISHED = /:(\d+)->/g;
const DOCKER_PROCESSES = new Set([
	"com.docker.backend.exe",
	"wslrelay.exe",
	"vpnkit.exe",
	"docker-proxy",
]);
/** Programs dev servers run on: a port one of them holds is shown even when no catalogued service wants it. */
const DEV_RUNTIMES = new Set([
	"bun.exe",
	"deno.exe",
	"node.exe",
	"python.exe",
	"pythonw.exe",
	"uv.exe",
	"java.exe",
	"dotnet.exe",
	"php.exe",
	"ruby.exe",
	"go.exe",
	"postgres.exe",
	"redis-server.exe",
	"nginx.exe",
	"caddy.exe",
	"ollama.exe",
]);
/** Ports from here up are handed out for a moment (VPNs and games listen there): not dev servers. */
const EPHEMERAL_PORTS = 49_152;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const windowsPath = (path: string): string =>
	path.replaceAll("/", "\\").replace(TRAILING_SLASH, "");

/**
 * The checkout a process runs from: the first absolute path in its command lines, up to its tool folders
 * (`.venv`, `node_modules`, `src`…); failing that, the project folder under the code folder a path is in.
 */
export function checkoutOf(
	commands: readonly string[],
	code?: string
): string | null {
	const paths = commands.flatMap((command) =>
		(command.match(WINDOWS_PATH) ?? []).map(windowsPath)
	);
	for (const path of paths) {
		const end = CHECKOUT_END.exec(path);
		if (end) {
			return path.slice(0, end.index);
		}
	}
	if (!code) {
		return null;
	}
	const root = `${windowsPath(code)}\\`;
	for (const path of paths) {
		if (path.toLowerCase().startsWith(root.toLowerCase())) {
			const [project] = path.slice(root.length).split("\\");
			if (project) {
				return `${path.slice(0, root.length)}${project}`;
			}
		}
	}
	return null;
}

export const samePath = (a: string, b: string): boolean =>
	a.replaceAll("/", "\\").replace(TRAILING_SLASH, "").toLowerCase() ===
	b.replaceAll("/", "\\").replace(TRAILING_SLASH, "").toLowerCase();

/** Host ports the running containers publish, and their compose projects. */
export function publishedPorts(docker: DockerView): Map<number, string> {
	const ports = new Map<number, string>();
	for (const project of docker.projects) {
		for (const container of project.containers) {
			if (!container.running) {
				continue;
			}
			for (const match of container.ports.matchAll(PUBLISHED)) {
				ports.set(Number(match[1]), project.name);
			}
		}
	}
	return ports;
}

/** Whether the overview lists a port: dev servers, Docker and the hub, not every program that listens. */
export function worthShowing(entry: {
	owner: OwnerView;
	port: number;
	service: string | null;
}): boolean {
	if (entry.service || entry.owner.docker) {
		return true;
	}
	if (entry.port >= EPHEMERAL_PORTS) {
		return false;
	}
	return (
		entry.owner.checkout !== null ||
		DEV_RUNTIMES.has(entry.owner.name.toLowerCase())
	);
}

interface Health {
	ok: boolean;
	pid: number;
}

interface Claim {
	/** The service is really the one on the port (external), or another holds it (busy). */
	holds: boolean;
	owner: OwnerView;
}

/** Runtime hooks let lifecycle checks run without launching applications in tests. */
export interface HubRuntime {
	composeAction?: typeof composeAction;
	dockerView?: typeof dockerView;
	healthy?: typeof healthy;
	listeningPorts?: typeof listeningPorts;
	listeningPortsV6?: typeof listeningPortsV6;
	noPortWarmupMs?: number;
	processes?: Processes;
	processInfo?: typeof processInfo;
	startPollMs?: number;
	startupTimeoutMs?: number;
}

export class Hub {
	private readonly catalogue: Catalogue;
	private readonly services: Service[];
	private readonly composeConfigs: ComposeConfig[];
	readonly processes: Processes;
	private readonly runtime: Required<HubRuntime>;
	private readonly starting = new Map<string, Promise<void>>();
	private readonly cancelledStarts = new Set<string>();
	private readonly composing = new Map<string, Promise<void>>();
	private readonly operations = new Map<string, Promise<void>>();
	private launching: Promise<void> = Promise.resolve();
	private view: HubView;
	private readonly listeners = new Set<(view: HubView) => void>();
	private readonly info = new Map<number, ProcessInfo>();
	private ports = new Map<number, number>();
	/** Each listening service's last health answer, and the process it was about. */
	private health = new Map<string, Health>();
	private claims = new Map<string, Claim>();
	private docker: DockerView = { available: false, projects: [] };
	private ticks = 0;
	private readonly startedAt = Date.now();
	private timer: ReturnType<typeof setInterval> | null = null;
	/** The reading under way, and the one queued after it. */
	private reading: Promise<void> | null = null;
	private next: Promise<void> | null = null;
	private wantFull = false;

	constructor(catalogue: Catalogue, root: string, runtime: HubRuntime = {}) {
		this.catalogue = catalogue;
		this.services = servicesOf(catalogue);
		this.composeConfigs = catalogue.projects.flatMap((project) => {
			if (!project.compose) {
				return [];
			}
			const path =
				this.services.find((service) => service.project.id === project.id)
					?.project.path ?? project.path;
			const file = resolve(path, project.compose.file);
			return [
				{
					file: existsSync(file) ? file : null,
					name: project.compose.project,
					overrides: project.compose.overrides.map((override) =>
						resolve(path, override)
					),
					project: project.id,
					wanted: project.compose.services,
				},
			];
		});
		this.processes = runtime.processes ?? new Processes(root);
		this.runtime = {
			composeAction,
			dockerView,
			healthy,
			listeningPorts,
			listeningPortsV6,
			noPortWarmupMs: NO_PORT_WARMUP_MS,
			processes: this.processes,
			processInfo,
			startPollMs: START_POLL_MS,
			startupTimeoutMs: WARMUP_MS,
			...runtime,
		};
		this.view = {
			docker: this.docker,
			hub: this.startedAt,
			ports: [],
			projects: [],
			updatedAt: 0,
		};
	}

	async start(): Promise<void> {
		await this.processes.adopt();
		await this.refresh(true);
		this.timer = setInterval(() => this.tick(), TICK_MS);
	}

	/**
	 * With no page open the hub only notes which of its own servers ended; with one open it reads the computer, in
	 * full every few ticks. A slow reading (a health page that takes its time) is not queued up behind.
	 */
	private tick(): void {
		this.ticks += 1;
		if (this.listeners.size === 0) {
			this.processes.sweep();
			return;
		}
		if (!this.reading) {
			this.refresh(this.ticks % FULL_EVERY === 0).catch(() => undefined);
		}
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}

	get current(): HubView {
		return this.view;
	}

	/** Tells a page every change; the first page after a quiet spell gets a full reading straight away. */
	subscribe(listener: (view: HubView) => void): () => void {
		const quiet = this.listeners.size === 0;
		this.listeners.add(listener);
		if (quiet) {
			this.refresh(true).catch(() => undefined);
		}
		return () => this.listeners.delete(listener);
	}

	service(key: string): Service | undefined {
		return this.services.find((service) => service.key === key);
	}

	/**
	 * Reads the computer again and tells subscribers when anything changed. One reading runs at a time; a call
	 * during one gets the reading after it, which sees what the caller has just done.
	 */
	refresh(full = false): Promise<void> {
		this.wantFull ||= full;
		if (this.next) {
			return this.next;
		}
		if (this.reading) {
			this.next = this.reading.then(() => {
				this.next = null;
				return this.refresh();
			});
			return this.next;
		}
		const whole = this.wantFull;
		this.wantFull = false;
		this.reading = this.read(whole)
			.catch(() => undefined)
			.finally(() => {
				this.reading = null;
			});
		return this.reading;
	}

	/** Ports, owners, health; in full also Docker and every health page again. */
	private async read(full: boolean): Promise<void> {
		const [v4, v6] = await Promise.all([
			this.runtime.listeningPorts(),
			this.runtime.listeningPortsV6(),
		]);
		this.ports = new Map([...v6, ...v4]);
		this.processes.sweep();
		if (full) {
			await this.readDocker();
		}
		await this.readOwners();
		await this.readHealth(full);
		this.claims = this.claim();
		const next = this.build();
		const changed =
			JSON.stringify({ ...next, updatedAt: 0 }) !==
			JSON.stringify({ ...this.view, updatedAt: 0 });
		this.view = next;
		if (changed) {
			for (const listener of this.listeners) {
				listener(next);
			}
		}
	}

	private async readDocker(): Promise<void> {
		const found = await this.runtime.dockerView();
		this.docker = {
			available: found.available,
			projects: withCatalogue(found.projects, this.composeConfigs),
		};
	}

	/** Command lines of new processes behind ports and of their ancestors, which name the checkout. */
	private async readOwners(): Promise<void> {
		// Process ids are reused: forget the processes that ended.
		for (const pid of this.info.keys()) {
			if (!alive(pid)) {
				this.info.delete(pid);
			}
		}
		let wanted = [...new Set(this.ports.values())].filter(
			(pid) => !this.info.has(pid)
		);
		for (let level = 0; level < ANCESTORS && wanted.length > 0; level += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: each level asks for the parents of the one before
			const found = await this.runtime.processInfo(wanted);
			for (const pid of wanted) {
				this.info.set(
					pid,
					found.get(pid) ?? { command: "", name: "", parent: 0, pid }
				);
			}
			wanted = [...found.values()]
				.map((entry) => entry.parent)
				.filter((pid) => pid > 0 && !this.info.has(pid));
		}
	}

	/**
	 * Asks the health pages of services that listen: all of them in a full reading, otherwise only the ones whose
	 * port has a new process, and the ones the hub started that are not healthy yet. The rest keep their answer.
	 */
	private async readHealth(full: boolean): Promise<void> {
		const next = new Map<string, Health>();
		const asks: Promise<void>[] = [];
		for (const service of this.services) {
			const pid = service.port ? this.ports.get(service.port) : undefined;
			if (pid === undefined) {
				continue;
			}
			const known = this.health.get(service.key);
			const managed = this.processes.get(service.key);
			const settling = Boolean(managed && !managed.exit && !known?.ok);
			if (known && known.pid === pid && !full && !settling) {
				next.set(service.key, known);
				continue;
			}
			const url = healthUrl(service);
			asks.push(
				(url ? this.runtime.healthy(url) : Promise.resolve(true)).then((ok) => {
					next.set(service.key, { ok, pid });
				})
			);
		}
		await Promise.all(asks);
		this.health = next;
	}

	private owner(pid: number, port?: number): OwnerView {
		const chain: ProcessInfo[] = [];
		let current = this.info.get(pid);
		for (let level = 0; current && level <= ANCESTORS; level += 1) {
			chain.push(current);
			current = current.parent ? this.info.get(current.parent) : undefined;
		}
		const [self] = chain;
		const name = self?.name ?? "";
		const docker =
			port !== undefined && DOCKER_PROCESSES.has(name)
				? (publishedPorts(this.docker).get(port) ?? null)
				: null;
		const checkout = checkoutOf(
			chain.map((entry) => entry.command),
			this.catalogue.code
		);
		let label = `${name || "процесс"} (PID ${pid})`;
		if (pid === process.pid) {
			label = "этот пульт";
		} else if (docker) {
			label = `Docker, проект ${docker}`;
		} else if (checkout) {
			label = `${label} из ${checkout}`;
		}
		return {
			checkout,
			command: chain.find((entry) => entry.command)?.command ?? "",
			docker,
			label,
			name,
			pid,
		};
	}

	/** Gives every held port to the service it really is; the other services wanting it are busy. */
	private claim(): Map<string, Claim> {
		const claims = new Map<string, Claim>();
		const byPort = new Map<number, Service[]>();
		for (const service of this.services) {
			if (service.port) {
				byPort.set(service.port, [
					...(byPort.get(service.port) ?? []),
					service,
				]);
			}
		}
		for (const [port, wanting] of byPort) {
			const pid = this.ports.get(port);
			if (pid === undefined) {
				continue;
			}
			const owner = this.owner(pid, port);
			const started = wanting.find((service) => {
				const managed = this.processes.get(service.key);
				return managed && !managed.exit && this.ownsPort(service, managed);
			});
			const holder = started ?? this.holderOf(wanting, owner);
			for (const service of wanting) {
				if (service !== started) {
					claims.set(service.key, { holds: service === holder, owner });
				}
			}
		}
		return claims;
	}

	private ownsPort(service: Service, managed: Managed): boolean {
		const pid = service.port ? this.ports.get(service.port) : undefined;
		if (pid === managed.pid) {
			return true;
		}
		let current = pid === undefined ? undefined : this.info.get(pid);
		for (let level = 0; current && level < ANCESTORS; level += 1) {
			if (current.parent === managed.pid) {
				return true;
			}
			current = this.info.get(current.parent);
		}
		return false;
	}

	private holderOf(wanting: Service[], owner: OwnerView): Service | undefined {
		if (owner.docker) {
			return wanting.find(
				(service) => service.project.compose?.project === owner.docker
			);
		}
		const { checkout } = owner;
		if (checkout) {
			const same = wanting.find((service) =>
				samePath(service.project.path, checkout)
			);
			if (same) {
				return same;
			}
		}
		const answering = wanting.filter(
			(service) =>
				this.health.get(service.key)?.ok && healthUrl(service) !== null
		);
		if (answering.length === 1) {
			return answering[0];
		}
		return wanting.length === 1 ? wanting[0] : undefined;
	}

	private managedStatus(
		service: Service,
		managed: Managed
	): {
		owner: OwnerView | null;
		status: ServiceStatus;
	} {
		const listening =
			service.port !== undefined && this.ports.has(service.port);
		const ok = this.health.get(service.key)?.ok ?? false;
		if (listening && !this.ownsPort(service, managed)) {
			const pid = this.ports.get(service.port ?? 0);
			return {
				owner: pid === undefined ? null : this.owner(pid, service.port),
				status: "busy",
			};
		}
		if (!service.port || (listening && ok)) {
			return { owner: null, status: "running" };
		}
		const warming =
			Date.now() - managed.startedAt < this.runtime.startupTimeoutMs;
		return { owner: null, status: warming ? "starting" : "unhealthy" };
	}

	private statusOf(service: Service): {
		owner: OwnerView | null;
		status: ServiceStatus;
	} {
		const managed = this.processes.get(service.key);
		if (managed && !managed.exit) {
			return this.managedStatus(service, managed);
		}
		const ok = this.health.get(service.key)?.ok ?? false;
		const claim = this.claims.get(service.key);
		if (claim && !claim.holds) {
			return { owner: claim.owner, status: "busy" };
		}
		if (claim) {
			return { owner: claim.owner, status: ok ? "external" : "unhealthy" };
		}
		if (managed?.exit && !managed.stopping && managed.exit.code !== 0) {
			return { owner: null, status: "crashed" };
		}
		return { owner: null, status: "stopped" };
	}

	private compose(name: string): ComposeView | undefined {
		return this.docker.projects.find((project) => project.name === name);
	}

	private needsOf(
		service: Service,
		statuses: Map<string, ServiceStatus>
	): NeedView[] {
		return service.needs.map((need): NeedView => {
			if (need.startsWith(DOCKER_NEED)) {
				const name = need.slice(DOCKER_NEED.length);
				const project = this.compose(name);
				const wanted = project?.wanted.length
					? ` (${project.wanted.join(", ")})`
					: "";
				return {
					key: need,
					label: `Docker ${name}${wanted}`,
					up: project?.ready ?? false,
				};
			}
			const status = statuses.get(need);
			return {
				key: need,
				label: this.service(need)?.name ?? need,
				up:
					status === "running" &&
					Boolean(this.processes.get(need) && !this.processes.get(need)?.exit),
			};
		});
	}

	private serviceView(
		service: Service,
		statuses: Map<string, ServiceStatus>
	): ServiceView {
		const managed = this.processes.get(service.key);
		const { owner, status } = this.statusOf(service);
		const live = managed && !managed.exit;
		// Another checkout matters only for a service the hub could start from its own one.
		const checkout =
			status === "busy" || !service.command ? null : owner?.checkout;
		return {
			canStart: Boolean(service.command),
			command: service.command ?? null,
			description: service.description ?? null,
			elsewhere:
				checkout && !samePath(checkout, service.project.path) ? checkout : null,
			exit: managed?.exit ?? null,
			health: healthUrl(service),
			key: service.key,
			managed: Boolean(live),
			name: service.name,
			needs: this.needsOf(service, statuses),
			owner,
			pid: live ? managed.pid : (owner?.pid ?? null),
			port: service.port ?? null,
			project: service.project.id,
			since: live ? managed.startedAt : null,
			status,
			ui: service.ui.map((entry) => ({
				label: entry.label,
				url: uiUrl(service, entry.url),
			})),
			warn: service.warn ?? null,
			workdir: service.workdir,
		};
	}

	private build(): HubView {
		const holders = new Map<number, string>();
		const statuses = new Map<string, ServiceStatus>();
		for (const service of this.services) {
			const managed = this.processes.get(service.key);
			const claim = this.claims.get(service.key);
			if (
				service.port &&
				((managed && !managed.exit && this.ownsPort(service, managed)) ||
					claim?.holds)
			) {
				holders.set(service.port, service.key);
			}
			statuses.set(service.key, this.statusOf(service).status);
		}
		const projects: ProjectView[] = this.catalogue.projects.map((project) => {
			const services = this.services.filter(
				(service) => service.project.id === project.id
			);
			return {
				description: project.description ?? null,
				docker: project.compose
					? (this.compose(project.compose.project) ?? null)
					: null,
				id: project.id,
				name: project.name,
				path: services[0]?.project.path ?? project.path,
				services: services.map((service) =>
					this.serviceView(service, statuses)
				),
			};
		});
		const ports: PortView[] = [...this.ports.entries()]
			.map(([port, pid]) => ({
				owner: this.owner(pid, port),
				port,
				service: holders.get(port) ?? null,
			}))
			.filter(worthShowing)
			.sort((a, b) => a.port - b.port);
		return {
			docker: this.docker,
			hub: this.startedAt,
			ports,
			projects,
			updatedAt: Date.now(),
		};
	}

	private viewOf(key: string): ServiceView | undefined {
		return this.current.projects
			.flatMap((project) => project.services)
			.find((entry) => entry.key === key);
	}

	/** Brings up what a service needs from a Docker project and waits until it is healthy. */
	private ensureCompose(name: string): Promise<void> {
		const current = this.composing.get(name);
		if (current) {
			return current;
		}
		const ready = this.ensureComposeReady(name);
		this.composing.set(name, ready);
		ready
			.finally(() => {
				if (this.composing.get(name) === ready) {
					this.composing.delete(name);
				}
			})
			.catch(() => undefined);
		return ready;
	}

	private async ensureComposeReady(name: string): Promise<void> {
		if (this.compose(name)?.ready) {
			return;
		}
		await this.composeAction(name, "up");
		const deadline = Date.now() + COMPOSE_READY_MS;
		while (!this.compose(name)?.ready && Date.now() < deadline) {
			// biome-ignore lint/performance/noAwaitInLoops: waiting for the containers to become healthy
			await sleep(1000);
			await this.readDocker();
		}
		const project = this.compose(name);
		if (!project?.ready) {
			const waiting = project?.wanted.join(", ") || "контейнеры";
			throw new Error(
				`Docker ${name} поднят, но ${waiting} не стал здоровым за ${COMPOSE_READY_MS / 1000} с`
			);
		}
	}

	/** One mutation per service at a time, shared by requests from the page and CLI. */
	private serialize(key: string, work: () => Promise<void>): Promise<void> {
		const previous = this.operations.get(key) ?? Promise.resolve();
		const operation = previous.catch(() => undefined).then(work);
		this.operations.set(key, operation);
		operation
			.finally(() => {
				if (this.operations.get(key) === operation) {
					this.operations.delete(key);
				}
			})
			.catch(() => undefined);
		return operation;
	}

	/** Starts once, after ready managed dependencies, and resolves only once this service is ready. */
	startService(key: string, chain: string[] = []): Promise<void> {
		const service = this.service(key);
		if (!service) {
			return Promise.reject(new Error(`нет сервиса ${key}`));
		}
		if (chain.includes(key)) {
			return Promise.reject(
				new Error(
					`сервисы ждут друг друга по кругу: ${[...chain, key].join(" → ")}`
				)
			);
		}
		const current = this.starting.get(key);
		if (current) {
			return current;
		}
		const starting = this.serialize(key, () => this.startReady(service, chain));
		this.starting.set(key, starting);
		starting
			.finally(() => {
				if (this.starting.get(key) === starting) {
					this.starting.delete(key);
					this.cancelledStarts.delete(key);
				}
			})
			.catch(() => undefined);
		return starting;
	}

	private assertPortFree(service: Service): void {
		if (service.port) {
			const reserved = this.services.find((candidate) => {
				const managed = this.processes.get(candidate.key);
				return (
					candidate.key !== service.key &&
					candidate.port === service.port &&
					managed &&
					!managed.exit &&
					alive(managed.pid)
				);
			});
			if (reserved) {
				throw new Error(
					`порт ${service.port} уже выделен ${reserved.key}, который devhub запускает или обслуживает`
				);
			}
		}
		const pid = service.port ? this.ports.get(service.port) : undefined;
		if (pid === undefined) {
			return;
		}
		const owner = this.owner(pid, service.port);
		throw new Error(
			`порт ${service.port} занят: его держит ${owner.label}. Остановите прежний запуск и запустите ${service.key} через devhub`
		);
	}

	private async startReady(service: Service, chain: string[]): Promise<void> {
		await this.refresh(true);
		this.assertStartWanted(service.key);
		const current = this.processes.get(service.key);
		if (current && !current.exit && alive(current.pid)) {
			await this.waitReady(service);
			return;
		}
		this.assertPortFree(service);
		for (const need of service.needs) {
			if (need.startsWith(DOCKER_NEED)) {
				// biome-ignore lint/performance/noAwaitInLoops: what a service needs comes up in order
				await this.ensureCompose(need.slice(DOCKER_NEED.length));
				continue;
			}
			// A foreign process cannot satisfy a managed development dependency.
			await this.startService(need, [...chain, service.key]);
		}
		const launching = this.launching
			.catch(() => undefined)
			.then(async () => {
				await this.refresh();
				this.assertStartWanted(service.key);
				this.assertPortFree(service);
				await this.processes.start(service);
			});
		this.launching = launching;
		await launching;
		await this.waitReady(service);
	}

	private assertStartWanted(key: string): void {
		if (this.cancelledStarts.has(key)) {
			throw new Error(`${key}: запуск отменён запросом на остановку`);
		}
	}

	private async waitReady(service: Service): Promise<void> {
		const began = Date.now();
		const deadline = began + this.runtime.startupTimeoutMs;
		do {
			this.assertStartWanted(service.key);
			// biome-ignore lint/performance/noAwaitInLoops: startup waits on the next real health reading
			await this.refresh();
			const managed = this.processes.get(service.key);
			if (!managed || managed.exit || !alive(managed.pid)) {
				const code = managed?.exit?.code;
				throw new Error(
					`${service.key} завершился до готовности${code === null || code === undefined ? "" : ` (код ${code})`}; смотрите лог сервиса`
				);
			}
			const ready = service.port
				? this.viewOf(service.key)?.status === "running"
				: Date.now() - began >= this.runtime.noPortWarmupMs;
			if (ready) {
				return;
			}
			if (this.viewOf(service.key)?.status === "busy") {
				this.assertPortFree(service);
			}
			await sleep(this.runtime.startPollMs);
		} while (Date.now() <= deadline);
		throw new Error(
			`${service.key} не стал готов за ${this.runtime.startupTimeoutMs / 1000} с; смотрите лог сервиса`
		);
	}

	/**
	 * Stops a service: the process the hub started, or with `external` whatever runs it elsewhere (its process tree,
	 * or its Docker project). A port held by another service is never touched.
	 */
	async stopService(key: string, external = false): Promise<void> {
		const service = this.service(key);
		if (!service) {
			throw new Error(`нет сервиса ${key}`);
		}
		if (this.starting.has(key)) {
			this.cancelledStarts.add(key);
		}
		await this.serialize(key, async () => {
			await this.refresh();
			const stopped = await this.processes.stop(service);
			const claim = this.claims.get(key);
			if (!stopped && external && claim?.holds) {
				if (claim.owner.docker) {
					await this.composeAction(claim.owner.docker, "stop");
				} else {
					await killTree(claim.owner.pid);
				}
			}
			await this.refresh();
		});
	}

	async restartService(key: string, external = true): Promise<void> {
		if (!external) {
			await this.refresh();
			const configured = this.service(key);
			const managed = this.processes.get(key);
			if (configured && (!managed || managed.exit)) {
				this.assertPortFree(configured);
			}
		}
		await this.stopService(key, external);
		const service = this.service(key);
		const deadline = Date.now() + PORT_FREE_MS;
		while (
			service?.port &&
			this.ports.has(service.port) &&
			Date.now() < deadline
		) {
			// biome-ignore lint/performance/noAwaitInLoops: waiting for the port to be let go
			await sleep(500);
			await this.refresh();
		}
		await this.startService(key);
	}

	/** Starts every startable service of a project that is not up yet; returns what could not start. */
	async startProject(id: string): Promise<string[]> {
		const errors: string[] = [];
		const project = this.current.projects.find((entry) => entry.id === id);
		if (!project) {
			throw new Error(`нет проекта ${id}`);
		}
		const defaults = this.catalogue.projects.find((entry) => entry.id === id)
			?.launch.dev;
		const keys = defaults
			? defaults.map((key) => (key.includes("/") ? key : `${id}/${key}`))
			: project.services
					.filter((service) => service.canStart)
					.map((service) => service.key);
		for (const key of new Set(keys)) {
			const view = this.viewOf(key);
			if (view?.managed && view.status === "running") {
				continue;
			}
			try {
				// biome-ignore lint/performance/noAwaitInLoops: one after another, so what they need comes up first
				await this.startService(key);
			} catch (error) {
				errors.push(
					`${this.service(key)?.name ?? key}: ${(error as Error).message}`
				);
			}
		}
		return errors;
	}

	async stopProject(id: string): Promise<void> {
		const project = this.current.projects.find((entry) => entry.id === id);
		if (!project) {
			throw new Error(`нет проекта ${id}`);
		}
		await Promise.all(
			(project?.services ?? [])
				.filter((service) => service.managed)
				.map((service) => this.stopService(service.key))
		);
	}

	/** Brings a Docker project up or stops it; when a port it needs is taken, says who holds it. */
	async composeAction(name: string, action: "up" | "stop"): Promise<void> {
		if (!this.docker.available) {
			// It may have come up since the last look.
			await this.readDocker();
		}
		if (!this.docker.available) {
			throw new Error(
				"Docker не отвечает: запустите Docker Desktop и подождите, пока он поднимется"
			);
		}
		const project = this.compose(name);
		if (!project) {
			throw new Error(`нет проекта Docker ${name}`);
		}
		try {
			await this.runtime.composeAction(project, action);
		} catch (error) {
			if (error instanceof DockerError && error.port !== null) {
				const pid = this.ports.get(error.port);
				if (pid !== undefined) {
					const owner = this.owner(pid, error.port);
					throw new Error(`${error.message}: его держит ${owner.label}`, {
						cause: error,
					});
				}
			}
			throw error;
		} finally {
			await this.readDocker();
			await this.refresh();
		}
	}
}
