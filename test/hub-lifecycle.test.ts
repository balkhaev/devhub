import { expect, test } from "bun:test";
import { sleep } from "bun";

import { catalogueSchema, type Service } from "../src/config";
import { Hub, type HubRuntime } from "../src/hub";
import { type Managed, Processes } from "../src/processes";

class FakeProcesses extends Processes {
	readonly entries = new Map<string, Managed>();
	readonly launches: string[] = [];
	readonly stops: string[] = [];
	onStart: (service: Service) => Promise<void> = async () => undefined;

	constructor() {
		super(".");
	}

	override async adopt(): Promise<void> {
		await Promise.resolve();
	}

	override get(key: string): Managed | undefined {
		return this.entries.get(key);
	}

	override sweep(): boolean {
		return false;
	}

	override async start(service: Service): Promise<Managed> {
		this.launches.push(service.key);
		const entry: Managed = {
			command: service.command ?? "",
			cwd: service.workdir,
			exit: null,
			log: "test.log",
			pid: process.pid,
			startedAt: Date.now(),
			stopping: false,
		};
		this.entries.set(service.key, entry);
		await this.onStart(service);
		return entry;
	}

	override async stop(service: Service): Promise<boolean> {
		const entry = this.entries.get(service.key);
		if (!entry || entry.exit) {
			return false;
		}
		this.stops.push(service.key);
		entry.stopping = true;
		entry.exit = { at: Date.now(), code: 0 };
		await Promise.resolve();
		return true;
	}
}

async function fixture(
	services: unknown[],
	runtime: HubRuntime = {},
	launch: Record<string, string[]> = {},
	projectPath = "."
) {
	const processes = new FakeProcesses();
	const ports = new Map<number, number>();
	const hub = new Hub(
		catalogueSchema.parse({
			projects: [
				{ id: "app", launch, name: "App", path: projectPath, services },
			],
		}),
		".",
		{
			dockerView: async () => ({ available: false, projects: [] }),
			healthy: async () => true,
			listeningPorts: async () => new Map(ports),
			listeningPortsV6: async () => new Map(),
			noPortWarmupMs: 2,
			processes,
			processInfo: async (pids) =>
				new Map(
					pids.map((pid) => [
						pid,
						{ command: "", name: "node.exe", parent: 0, pid },
					])
				),
			startPollMs: 1,
			startupTimeoutMs: 100,
			...runtime,
		}
	);
	await hub.start();
	hub.stop();
	return { hub, ports, processes };
}

const configService = (id: string, extra: Record<string, unknown> = {}) => ({
	command: `run-${id}`,
	id,
	name: id,
	...extra,
});

test("concurrent requests share a launch and resolve after health becomes ready", async () => {
	let healthy = false;
	const { hub, ports, processes } = await fixture(
		[configService("api", { health: "/ready", port: 3000 })],
		{ healthy: async () => healthy }
	);
	processes.onStart = async () => {
		ports.set(3000, process.pid);
		await Promise.resolve();
	};
	const first = hub.startService("app/api");
	const second = hub.startService("app/api");
	expect(first).toBe(second);
	let resolved = false;
	first
		.then(() => {
			resolved = true;
		})
		.catch(() => undefined);
	await sleep(5);
	expect(resolved).toBe(false);
	healthy = true;
	await Promise.all([first, second]);
	await hub.startService("app/api");
	expect(processes.launches).toEqual(["app/api"]);
	expect(hub.current.projects[0]?.services[0]?.status).toBe("running");
});

test("shared dependencies launch once and become healthy before either dependent starts", async () => {
	let dependencyReady = false;
	const { hub, ports, processes } = await fixture(
		[
			configService("api", { health: "/ready", port: 3000 }),
			configService("web", { needs: ["app/api"] }),
			configService("worker", { needs: ["app/api"] }),
		],
		{ healthy: async () => dependencyReady }
	);
	processes.onStart = async (started) => {
		if (started.key === "app/api") {
			ports.set(3000, process.pid);
		} else {
			expect(dependencyReady).toBe(true);
		}
		await Promise.resolve();
	};
	const launches = Promise.all([
		hub.startService("app/web"),
		hub.startService("app/worker"),
	]);
	await sleep(5);
	expect(processes.launches).toEqual(["app/api"]);
	dependencyReady = true;
	await launches;
	expect(processes.launches).toEqual(["app/api", "app/web", "app/worker"]);
});

test("starting a running dependent restores its stopped backend and waits for readiness without relaunching it", async () => {
	let backendReady = true;
	const { hub, ports, processes } = await fixture(
		[
			configService("api", { health: "/ready", port: 3000 }),
			configService("web", { needs: ["app/api"], port: 3001 }),
		],
		{ healthy: async () => backendReady }
	);
	processes.onStart = async (service) => {
		if (service.port) {
			ports.set(service.port, process.pid);
		}
		await Promise.resolve();
	};
	await hub.startService("app/web");
	const web = processes.get("app/web");
	await hub.stopService("app/api", false);
	ports.delete(3000);
	backendReady = false;
	let resolved = false;
	const restarted = hub.startService("app/web");
	restarted
		.then(() => {
			resolved = true;
		})
		.catch(() => undefined);
	await sleep(5);
	expect(processes.launches).toEqual(["app/api", "app/web", "app/api"]);
	expect(resolved).toBe(false);
	backendReady = true;
	await restarted;
	expect(processes.get("app/web")).toBe(web);
	expect(processes.launches).toEqual(["app/api", "app/web", "app/api"]);
	expect(hub.current.projects[0]?.services[1]?.needs[0]?.up).toBe(true);
});

test("an external dependency cannot satisfy development readiness, even when healthy", async () => {
	const { hub, ports, processes } = await fixture([
		configService("api", { health: "/ready", port: 3000 }),
		configService("web", { needs: ["app/api"] }),
	]);
	ports.set(3000, process.pid + 999_999);
	await expect(hub.startService("app/web")).rejects.toThrow("через devhub");
	expect(processes.launches).toEqual([]);
	expect(processes.stops).toEqual([]);
	expect(hub.current.projects[0]?.services[1]?.needs[0]?.up).toBe(false);
});

const DETACHED_PID = process.pid + 999_999;
const DETACHED_PARENT = DETACHED_PID + 1;
const QUEUE_COMMAND = ".venv/Scripts/python.exe -m inference.tray";

async function detachedFixture(
	options: {
		duplicatePort?: boolean;
		healthy?: boolean;
		listenerCommand?: string;
		parentCommand?: string;
		service?: Record<string, unknown>;
	} = {}
) {
	const parentCommand =
		options.parentCommand ??
		"D:/code/inference/.venv/Scripts/python.exe -m inference.cli --config D:/code/inference/inference.toml serve";
	const listenerCommand =
		options.listenerCommand ??
		"C:/runtime/python.exe -m inference.cli --config C:/inference.toml serve";
	const services = [
		configService("api", {
			command: QUEUE_COMMAND,
			detachedListener: true,
			health: "/health",
			port: 8765,
			...options.service,
		}),
		configService("web", { needs: ["app/api"] }),
	];
	if (options.duplicatePort) {
		services.push(configService("other", { port: 8765 }));
	}
	const result = await fixture(
		services,
		{
			healthy: async () => options.healthy ?? true,
			processInfo: async (pids) =>
				new Map(
					pids.map((pid) => [
						pid,
						{
							command: pid === DETACHED_PID ? listenerCommand : parentCommand,
							name: "python.exe",
							parent: pid === DETACHED_PID ? DETACHED_PARENT : 0,
							pid,
						},
					])
				),
		},
		{},
		"D:/code/inference"
	);
	result.processes.entries.set("app/api", {
		command: QUEUE_COMMAND,
		cwd: "D:/code/inference",
		exit: null,
		log: "test.log",
		pid: process.pid,
		startedAt: Date.now(),
		stopping: false,
	});
	result.ports.set(8765, DETACHED_PID);
	await result.hub.refresh(true);
	return result;
}

test("opted-in canonical detached queue satisfies readiness without adopting its listener", async () => {
	const { hub, processes } = await detachedFixture();
	const queue = hub.current.projects[0]?.services[0];
	expect(queue?.status).toBe("running");
	expect(queue?.pid).toBe(process.pid);
	expect(queue?.owner?.pid).toBe(DETACHED_PID);
	expect(queue?.owner?.checkout).toBe("D:\\code\\inference");
	await hub.startService("app/web");
	expect(processes.launches).toEqual(["app/web"]);
	expect(processes.get("app/api")?.pid).toBe(process.pid);
	expect(processes.stops).toEqual([]);
});

test.each([
	["default strict ownership", { service: { detachedListener: undefined } }],
	["explicit disabled contract", { service: { detachedListener: false } }],
	["foreign checkout", { parentCommand: "D:/code/other/.venv/python.exe" }],
	["unknown checkout", { parentCommand: "C:/runtime/python.exe" }],
	["failed health", { healthy: false }],
	["missing health", { service: { health: undefined } }],
	[
		"wrong health host",
		{ service: { health: "http://127.0.0.2:8765/health" } },
	],
	[
		"wrong health port",
		{ service: { health: "http://127.0.0.1:8089/health" } },
	],
	["wrong health endpoint", { service: { health: "/docs" } }],
	["ambiguous shared port", { duplicatePort: true }],
	["foreign listener module", { listenerCommand: "python.exe -m http.server" }],
	[
		"CLI without serve",
		{ listenerCommand: "python.exe -m inference.cli status" },
	],
	[
		"unknown supervisor contract",
		{ service: { command: "run-other-supervisor" } },
	],
] as const)("detached readiness refuses %s", async (_name, options) => {
	const { hub, processes } = await detachedFixture(options);
	expect(hub.current.projects[0]?.services[0]?.status).toBe("busy");
	await expect(hub.startService("app/web")).rejects.toThrow("порт 8765 занят");
	expect(processes.launches).toEqual([]);
	expect(processes.stops).toEqual([]);
});

test("detached readiness refuses stopping or dead supervisors", async () => {
	const { hub, processes } = await detachedFixture();
	const managed = processes.get("app/api");
	if (!managed) {
		throw new Error("Missing managed queue fixture");
	}
	managed.stopping = true;
	await hub.refresh(true);
	expect(hub.current.projects[0]?.services[0]?.status).toBe("busy");
	managed.stopping = false;
	managed.pid = process.pid + 999_997;
	await hub.refresh(true);
	expect(hub.current.projects[0]?.services[0]?.status).toBe("busy");
	expect(processes.stops).toEqual([]);
});

test("detached listener health is rechecked when the listening PID changes", async () => {
	const { hub, ports } = await detachedFixture();
	expect(hub.current.projects[0]?.services[0]?.status).toBe("running");
	ports.set(8765, DETACHED_PID + 2);
	await hub.refresh();
	expect(hub.current.projects[0]?.services[0]?.status).toBe("running");
	expect(hub.current.projects[0]?.services[0]?.owner?.pid).toBe(
		DETACHED_PID + 2
	);
});

test("a held unhealthy port is rejected without launching or stopping its owner", async () => {
	const { hub, ports, processes } = await fixture(
		[configService("api", { health: "/ready", port: 3000 })],
		{ healthy: async () => false }
	);
	ports.set(3000, process.pid + 999_999);
	await expect(hub.startService("app/api")).rejects.toThrow("порт 3000 занят");
	await expect(hub.restartService("app/api", false)).rejects.toThrow(
		"порт 3000 занят"
	);
	expect(processes.launches).toEqual([]);
	expect(processes.stops).toEqual([]);
	const errors = await hub.startProject("app");
	expect(errors).toHaveLength(1);
});

test("a process that exits during launch is reported as failed", async () => {
	const { hub, processes } = await fixture([configService("worker")]);
	processes.onStart = async (started) => {
		const entry = processes.get(started.key);
		if (entry) {
			entry.exit = { at: Date.now(), code: 2 };
		}
		await Promise.resolve();
	};
	await expect(hub.startService("app/worker")).rejects.toThrow("код 2");
});

test("a healthy foreign process appearing during launch cannot masquerade as the managed server", async () => {
	const { hub, ports, processes } = await fixture([
		configService("api", { health: "/ready", port: 3000 }),
	]);
	processes.onStart = async () => {
		ports.set(3000, process.pid + 999_999);
		await Promise.resolve();
	};
	await expect(hub.startService("app/api")).rejects.toThrow("порт 3000 занят");
	expect(hub.current.projects[0]?.services[0]?.status).toBe("busy");
	expect(processes.stops).toEqual([]);
});

test("two services sharing a port cannot launch while the first warms up", async () => {
	const { hub, processes } = await fixture(
		[
			configService("first", { port: 3000 }),
			configService("second", { port: 3000 }),
		],
		{ startupTimeoutMs: 15 }
	);
	const results = await Promise.allSettled([
		hub.startService("app/first"),
		hub.startService("app/second"),
	]);
	expect(processes.launches).toEqual(["app/first"]);
	expect(results[0]?.status).toBe("rejected");
	expect(results[1]?.status).toBe("rejected");
});

test("a stop during warmup cancels readiness and stops the launched process", async () => {
	const { hub, processes } = await fixture([
		configService("api", { port: 3000 }),
	]);
	let announceLaunch: () => void = () => undefined;
	const launched = new Promise<void>((resolveLaunch) => {
		announceLaunch = resolveLaunch;
	});
	processes.onStart = async () => {
		announceLaunch();
		await Promise.resolve();
	};
	const started = hub.startService("app/api");
	await launched;
	const stopped = hub.stopService("app/api");
	await expect(started).rejects.toThrow("запуск отменён");
	await stopped;
	expect(processes.launches).toEqual(["app/api"]);
	expect(processes.stops).toEqual(["app/api"]);
	expect(processes.get("app/api")?.stopping).toBe(true);
});

test("project start uses its declared default group and skips alternate variants", async () => {
	const { hub, processes } = await fixture(
		[configService("primary"), configService("alternate")],
		{},
		{ dev: ["app/primary", "primary"] }
	);
	expect(await hub.startProject("app")).toEqual([]);
	expect(processes.launches).toEqual(["app/primary"]);
});

test("unknown project operations fail explicitly", async () => {
	const { hub } = await fixture([]);
	await expect(hub.startProject("missing")).rejects.toThrow("нет проекта");
	await expect(hub.stopProject("missing")).rejects.toThrow("нет проекта");
});
