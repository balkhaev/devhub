import { afterEach, expect, test } from "bun:test";
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
		if (!entry) {
			return false;
		}
		entry.stopping = true;
		if (entry.exit) {
			return false;
		}
		this.stops.push(service.key);
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

const recoveringHubs = new Set<Hub>();
afterEach(() => {
	for (const hub of recoveringHubs) {
		hub.stop();
	}
	recoveringHubs.clear();
});

async function recoveryFixture(services: unknown[], runtime: HubRuntime = {}) {
	let now = Date.now();
	const result = await fixture(services, { ...runtime, now: () => now });
	await result.hub.start();
	recoveringHubs.add(result.hub);
	result.processes.onStart = async (service) => {
		if (service.port) {
			result.ports.set(service.port, process.pid);
		}
		await Promise.resolve();
	};
	return {
		...result,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
		crash: (key: string, code: number | null = null) => {
			const entry = result.processes.get(key);
			if (!entry) {
				throw new Error(`No test launcher for ${key}`);
			}
			entry.exit = { at: now, code };
			const port = result.hub.service(key)?.port;
			if (port) {
				result.ports.delete(port);
			}
		},
	};
}

const recoveringService = (id: string, extra: Record<string, unknown> = {}) =>
	configService(id, { restart: "on-failure", restartDelayMs: 100, ...extra });

test("a dead launcher recovers after its delay and concurrent manual and automatic starts share one launch", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("queue", { port: 8765 }),
	]);
	await hub.startService("app/queue");
	crash("app/queue");
	advance(99);
	await hub.recoverExited();
	expect(processes.launches).toEqual(["app/queue"]);
	advance(1);
	const recovery = hub.recoverExited();
	await Promise.all([
		recovery,
		hub.recoverExited(),
		hub.startService("app/queue"),
	]);
	expect(processes.launches).toEqual(["app/queue", "app/queue"]);
	expect(processes.stops).toEqual([]);
});

test("the background monitor recovers a failed launcher with no page subscribed", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("queue"),
	]);
	await hub.startService("app/queue");
	crash("app/queue", 75);
	advance(100);
	const deadline = Date.now() + 3000;
	while (processes.launches.length < 2 && Date.now() < deadline) {
		// biome-ignore lint/performance/noAwaitInLoops: observe the real background tick without launching any process
		await sleep(20);
	}
	expect(processes.launches).toEqual(["app/queue", "app/queue"]);
});

test("an unattended hub refreshes launcher identity before recovery even when its numeric PID is alive", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("fixture"),
	]);
	await hub.startService("app/fixture");
	let observed = false;
	processes.identityPids = () => [process.pid];
	processes.sweep = (info?: Map<number, unknown>) => {
		if (info?.has(process.pid) && !observed) {
			observed = true;
			crash("app/fixture");
			advance(100);
			return true;
		}
		return false;
	};
	const deadline = Date.now() + 3000;
	while (processes.launches.length < 2 && Date.now() < deadline) {
		// biome-ignore lint/performance/noAwaitInLoops: observe the real background tick with neutral fake processes
		await sleep(20);
	}
	expect(observed).toBe(true);
	expect(processes.launches).toEqual(["app/fixture", "app/fixture"]);
	hub.stop();
});

test("a failed pending-cancellation write cannot prevent the serialized stop of a known service", async () => {
	const { hub, processes } = await fixture([configService("fixture")]);
	await hub.startService("app/fixture");
	processes.cancelPending = () =>
		Promise.reject(new Error("cancellation disk failure"));
	await expect(hub.stopService("app/fixture")).rejects.toThrow(
		"cancellation disk failure"
	);
	expect(processes.stops).toEqual(["app/fixture"]);
});

test("a pending recovery cannot hold the unattended identity scan for unrelated services", async () => {
	let snapshots = 0;
	const { hub, processes } = await recoveryFixture(
		[recoveringService("fixture")],
		{
			processInfo: () => {
				snapshots += 1;
				return Promise.resolve(new Map());
			},
		}
	);
	processes.identityPids = () => [process.pid];
	let release: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	hub.recoverExited = () => pending;
	const deadline = Date.now() + 5000;
	try {
		while (snapshots < 2 && Date.now() < deadline) {
			// biome-ignore lint/performance/noAwaitInLoops: observe two actual monitor ticks while readiness is pending
			await sleep(20);
		}
		expect(snapshots).toBeGreaterThanOrEqual(2);
	} finally {
		hub.stop();
		release();
	}
});

test("a stop during retry backoff, including a project stop, cancels recovery until an explicit start", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("queue"),
	]);
	await hub.startService("app/queue");
	crash("app/queue");
	const stopped = hub.stopService("app/queue");
	advance(100);
	await Promise.all([stopped, hub.recoverExited()]);
	expect(processes.launches).toHaveLength(1);
	expect(processes.get("app/queue")?.stopping).toBe(true);
	await hub.startService("app/queue");
	crash("app/queue");
	await hub.refresh();
	await hub.stopProject("app");
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(2);
});

test("normal on-failure exits and never policies stay stopped; always still retries a normal exit", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("normal", { autostart: true }),
		recoveringService("manual", { restart: "never" }),
		recoveringService("always", { restart: "always" }),
	]);
	for (const key of ["app/normal", "app/manual", "app/always"]) {
		// biome-ignore lint/performance/noAwaitInLoops: finish each neutral fixture launch before recording its exit
		await hub.startService(key);
		crash(key, key === "app/manual" ? 2 : 0);
	}
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toEqual([
		"app/normal",
		"app/manual",
		"app/always",
		"app/always",
	]);
});

test("an occupied port is preserved and failed recovery waits another delay before retrying", async () => {
	const { hub, processes, ports, crash, advance } = await recoveryFixture([
		recoveringService("queue", { port: 8765 }),
	]);
	await hub.startService("app/queue");
	crash("app/queue");
	ports.set(8765, process.pid + 999_999);
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(1);
	expect(processes.stops).toEqual([]);
	ports.delete(8765);
	advance(99);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(1);
	advance(1);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(2);
});

test("automatic dependent recovery respects an explicitly stopped dependency, while manual start can restore it", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("queue"),
		recoveringService("executor", { needs: ["app/queue"] }),
	]);
	await hub.startService("app/executor");
	crash("app/executor");
	await hub.stopService("app/queue");
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toEqual(["app/queue", "app/executor"]);
	await hub.startService("app/executor");
	expect(processes.launches).toEqual([
		"app/queue",
		"app/executor",
		"app/queue",
		"app/executor",
	]);
});

test.each([
	{ code: 0, restart: "on-failure" },
	{ code: 2, restart: "never" },
])(
	"automatic dependencies preserve $restart after exit $code",
	async ({ code, restart }) => {
		const { hub, processes, crash, advance } = await recoveryFixture([
			recoveringService("backend", { restart }),
			recoveringService("worker", { needs: ["app/backend"] }),
		]);
		await hub.startService("app/worker");
		crash("app/backend", code);
		crash("app/worker", 2);
		advance(100);
		await hub.recoverExited();
		expect(processes.launches).toEqual(["app/backend", "app/worker"]);
		await hub.startService("app/worker");
		expect(processes.launches).toEqual([
			"app/backend",
			"app/worker",
			"app/backend",
			"app/worker",
		]);
	}
);

test("automatic dependencies cannot bypass their exit delay or failed-attempt cooldown", async () => {
	const { hub, processes, ports, crash, advance } = await recoveryFixture([
		recoveringService("backend", { port: 3100, restartDelayMs: 500 }),
		recoveringService("worker", { needs: ["app/backend"] }),
	]);
	await hub.startService("app/worker");
	crash("app/backend", 2);
	crash("app/worker", 2);
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(2);
	ports.set(3100, process.pid + 999_999);
	advance(400);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(2);
	ports.delete(3100);
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(2);
	advance(400);
	await hub.recoverExited();
	expect(processes.launches).toEqual([
		"app/backend",
		"app/worker",
		"app/backend",
		"app/worker",
	]);
	expect(processes.stops).toEqual([]);
});

test("one recovery waiting for readiness does not block a later unrelated recovery", async () => {
	let firstReady = true;
	const { hub, processes, crash, advance } = await recoveryFixture(
		[
			recoveringService("first", { health: "/health", port: 3100 }),
			recoveringService("second", { port: 3101 }),
		],
		{
			healthy: async (url) => !url.includes(":3100/") || firstReady,
			startupTimeoutMs: 1000,
		}
	);
	await hub.startService("app/first");
	await hub.startService("app/second");
	firstReady = false;
	crash("app/first", 2);
	advance(100);
	let firstFinished = false;
	const firstRecovery = hub.recoverExited().then(() => {
		firstFinished = true;
	});
	await sleep(5);
	expect(processes.launches).toEqual(["app/first", "app/second", "app/first"]);
	crash("app/second", 2);
	advance(100);
	await hub.recoverExited();
	expect(firstFinished).toBe(false);
	expect(processes.launches).toEqual([
		"app/first",
		"app/second",
		"app/first",
		"app/second",
	]);
	firstReady = true;
	await firstRecovery;
});

test("a stop while automatic recovery waits on dependency readiness prevents the pending dependent launch", async () => {
	let ready = true;
	const { hub, processes, crash, advance } = await recoveryFixture(
		[
			recoveringService("queue", { health: "/health", port: 8765 }),
			recoveringService("executor", { needs: ["app/queue"] }),
		],
		{ healthy: async () => ready }
	);
	await hub.startService("app/executor");
	crash("app/executor");
	ready = false;
	advance(100);
	const recovery = hub.recoverExited();
	await sleep(5);
	const stop = hub.stopService("app/executor");
	ready = true;
	await Promise.all([recovery, stop]);
	advance(100);
	await hub.recoverExited();
	expect(processes.launches).toEqual(["app/queue", "app/executor"]);
});

test("stopping the hub or removing the service prevents pending recovery", async () => {
	const { hub, processes, crash, advance } = await recoveryFixture([
		recoveringService("queue"),
	]);
	await hub.startService("app/queue");
	crash("app/queue");
	advance(100);
	hub.stop();
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(1);
	await hub.start();
	await hub.replaceCatalogue(catalogueSchema.parse({ projects: [] }));
	await hub.recoverExited();
	expect(processes.launches).toHaveLength(1);
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

const LISTENER_PID = process.pid + 999_999;
const VENV_LAUNCHER_PID = LISTENER_PID + 1;
const QUEUE_COMMAND = ".venv/Scripts/python.exe -m inference.cli serve";

/** A managed queue whose port is held by a listener with the given parents above it. */
async function listenerFixture(parents: Record<number, number>) {
	const result = await fixture(
		[
			configService("queue", {
				command: QUEUE_COMMAND,
				health: "/health",
				port: 8765,
			}),
			configService("relay", { needs: ["app/queue"] }),
		],
		{
			processInfo: async (pids) =>
				new Map(
					pids.map((pid) => [
						pid,
						{
							command: "python.exe -m inference.cli serve",
							name: "python.exe",
							parent: parents[pid] ?? 0,
							pid,
						},
					])
				),
		}
	);
	result.processes.entries.set("app/queue", {
		command: QUEUE_COMMAND,
		cwd: ".",
		exit: null,
		log: "test.log",
		pid: process.pid,
		startedAt: Date.now(),
		stopping: false,
	});
	result.ports.set(8765, LISTENER_PID);
	await result.hub.refresh(true);
	return result;
}

test("a listener a few processes under the managed launcher is the service itself", async () => {
	// cmd (the hub's batch file) -> the venv's python launcher -> the interpreter that listens.
	const { hub, processes } = await listenerFixture({
		[LISTENER_PID]: VENV_LAUNCHER_PID,
		[VENV_LAUNCHER_PID]: process.pid,
	});
	const queue = hub.current.projects[0]?.services[0];
	expect(queue?.status).toBe("running");
	expect(queue?.managed).toBe(true);
	expect(queue?.pid).toBe(process.pid);
	expect(queue?.owner).toBeNull();
	await hub.startService("app/relay");
	expect(processes.launches).toEqual(["app/relay"]);
	expect(processes.stops).toEqual([]);
});

test("a managed service whose port a foreign process holds is busy, however healthy the port answers", async () => {
	const { hub, processes } = await listenerFixture({
		[LISTENER_PID]: VENV_LAUNCHER_PID,
	});
	const queue = hub.current.projects[0]?.services[0];
	expect(queue?.status).toBe("busy");
	expect(queue?.owner?.pid).toBe(LISTENER_PID);
	await expect(hub.startService("app/relay")).rejects.toThrow(
		"порт 8765 занят"
	);
	expect(processes.launches).toEqual([]);
	expect(processes.stops).toEqual([]);
});

test("autostart brings up marked services after what they need and skips the ones the hub already runs", async () => {
	const { hub, ports, processes } = await fixture([
		configService("manual"),
		configService("executors", {
			autostart: true,
			needs: ["app/queue"],
			port: 8766,
		}),
		configService("queue", { autostart: true, health: "/health", port: 8765 }),
		configService("watched", { autostart: true, command: undefined }),
	]);
	processes.onStart = async (service) => {
		if (service.port) {
			ports.set(service.port, process.pid);
		}
		await Promise.resolve();
	};
	expect(hub.autostartPending()).toEqual(["app/executors", "app/queue"]);
	expect(await hub.startAutostart()).toEqual([]);
	expect(processes.launches).toEqual(["app/queue", "app/executors"]);
	expect(hub.autostartPending()).toEqual([]);
	// The hub started again beside servers that kept running: nothing is launched twice.
	expect(await hub.startAutostart()).toEqual([]);
	expect(processes.launches).toEqual(["app/queue", "app/executors"]);
});

test("autostart reports what could not start, leaves a foreign port owner alone and goes on", async () => {
	const { hub, ports, processes } = await fixture([
		configService("queue", { autostart: true, health: "/health", port: 8765 }),
		configService("executors", { autostart: true, name: "Executors" }),
	]);
	ports.set(8765, LISTENER_PID);
	const errors = await hub.startAutostart();
	expect(errors).toHaveLength(1);
	expect(errors[0]).toContain("queue: порт 8765 занят");
	expect(processes.launches).toEqual(["app/executors"]);
	expect(processes.stops).toEqual([]);
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
	await expect(hub.restartProject("missing")).rejects.toThrow("нет проекта");
});

test("restarting a project brings its running services back and leaves stopped ones down", async () => {
	const { hub, processes } = await fixture([
		configService("primary"),
		configService("alternate"),
	]);
	await hub.startService("app/primary");
	expect(await hub.restartProject("app")).toEqual([]);
	expect(processes.stops).toEqual(["app/primary"]);
	expect(processes.launches).toEqual(["app/primary", "app/primary"]);
	expect(
		hub.current.projects[0]?.services.map((service) => [
			service.key,
			service.status,
		])
	).toEqual([
		["app/primary", "running"],
		["app/alternate", "stopped"],
	]);
});

test("restarting a project with nothing running says so", async () => {
	const { hub, processes } = await fixture([configService("primary")]);
	await expect(hub.restartProject("app")).rejects.toThrow(
		"нечего перезапускать"
	);
	expect(processes.launches).toEqual([]);
	expect(processes.stops).toEqual([]);
});
