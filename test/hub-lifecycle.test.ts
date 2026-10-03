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
	launch: Record<string, string[]> = {}
) {
	const processes = new FakeProcesses();
	const ports = new Map<number, number>();
	const hub = new Hub(
		catalogueSchema.parse({
			projects: [{ id: "app", launch, name: "App", path: ".", services }],
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
