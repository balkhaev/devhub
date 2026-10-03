import { expect, test } from "bun:test";

import {
	type ComposeView,
	type ContainerView,
	composeArguments,
	dockerError,
	parseDocker,
	readyOf,
	withCatalogue,
} from "../src/docker";

const LS = JSON.stringify([
	{
		ConfigFiles: "D:\\code\\gameradar\\docker-compose.yml",
		Name: "gameradar",
		Status: "exited(1), running(3)",
	},
	{
		ConfigFiles: "D:\\code\\delopusk\\docker-compose.yml",
		Name: "delopusk",
		Status: "running(1)",
	},
]);

const PS = [
	{
		Labels:
			"com.docker.compose.project=gameradar,com.docker.compose.service=gameradar",
		Names: "gameradar-gameradar-1",
		Ports: "0.0.0.0:3000->3000/tcp",
		State: "running",
		Status: "Up 3 hours (unhealthy)",
	},
	{
		Labels:
			"com.docker.compose.service=postgres,com.docker.compose.project=gameradar",
		Names: "gameradar-postgres-1",
		Ports: "5432/tcp",
		State: "running",
		Status: "Up 3 hours (healthy)",
	},
	{
		Labels:
			"com.docker.compose.project=gameradar,com.docker.compose.service=db-migrate",
		Names: "gameradar-db-migrate-1",
		Ports: "",
		State: "exited",
		Status: "Exited (0) 3 hours ago",
	},
	{
		Labels:
			"com.docker.compose.project=delopusk,com.docker.compose.service=postgres",
		Names: "delopusk-postgres",
		Ports: "0.0.0.0:5432->5432/tcp",
		State: "running",
		Status: "Up 2 days",
	},
]
	.map((entry) => JSON.stringify(entry))
	.join("\n");

test("compose projects come with their own containers, health and exit codes", () => {
	const [gameradar, delopusk] = parseDocker(LS, PS);
	expect(gameradar?.name).toBe("gameradar");
	expect(gameradar?.file).toBe("D:\\code\\gameradar\\docker-compose.yml");
	expect(gameradar?.containers.map((container) => container.service)).toEqual([
		"gameradar",
		"postgres",
		"db-migrate",
	]);
	const [app, postgres, migrate] = gameradar?.containers ?? [];
	expect(app?.health).toBe("unhealthy");
	expect(postgres?.health).toBe("healthy");
	expect(migrate?.exitCode).toBe(0);
	expect(migrate?.running).toBe(false);
	// The app is unhealthy: the project is not ready.
	expect(gameradar?.ready).toBe(false);
	expect(delopusk?.ready).toBe(true);
});

test("Docker that does not answer gives no projects", () => {
	expect(parseDocker("", "")).toEqual([]);
	expect(parseDocker("not json", "")).toEqual([]);
});

const running = (service: string, extra: Partial<ContainerView> = {}) => ({
	exitCode: null,
	health: null,
	name: `x-${service}-1`,
	ports: "",
	running: true,
	service,
	status: "Up",
	...extra,
});

test("a project is ready when what the dev servers need runs well", () => {
	const containers: ContainerView[] = [
		running("postgres", { health: "healthy" }),
		running("web", { exitCode: 137, running: false }),
	];
	expect(readyOf(containers, ["postgres"])).toBe(true);
	expect(readyOf(containers, [])).toBe(false);
	expect(
		readyOf([running("postgres", { health: "starting" })], ["postgres"])
	).toBe(false);
	expect(readyOf([], ["postgres"])).toBe(false);
	expect(readyOf([], [])).toBe(false);
	// A migration that finished well does not hold its project down.
	expect(
		readyOf(
			[running("app"), running("migrate", { exitCode: 0, running: false })],
			[]
		)
	).toBe(true);
});

test("the catalogue adds what it needs from each project and the projects Docker has not created", () => {
	const docker = parseDocker(LS, PS);
	const merged = withCatalogue(docker, [
		{
			file: "D:\\code\\gameradar\\docker-compose.yml",
			name: "gameradar",
			project: "gameradar",
			wanted: [],
		},
		{
			file: "D:\\code\\montage\\docker-compose.yml",
			name: "montage",
			project: "montage",
			wanted: ["postgres"],
		},
	]);
	const byName = new Map(merged.map((project) => [project.name, project]));
	expect(byName.get("gameradar")?.project).toBe("gameradar");
	expect(byName.get("delopusk")?.project).toBeNull();
	const montage = byName.get("montage") as ComposeView;
	expect(montage.containers).toEqual([]);
	expect(montage.ready).toBe(false);
	expect(montage.wanted).toEqual(["postgres"]);
	expect(montage.file).toBe("D:\\code\\montage\\docker-compose.yml");
});

test("Docker's refusals are said in words, with the port it could not take", () => {
	const allocated = dockerError("montage", {
		code: 1,
		err: "Error response from daemon: driver failed programming external connectivity on endpoint montage-postgres-1: Bind for 0.0.0.0:5432 failed: port is already allocated",
		out: "",
	});
	expect(allocated.port).toBe(5432);
	expect(allocated.message).toBe("Docker montage: порт 5432 уже занят");

	const windows = dockerError("adorely", {
		code: 1,
		err: "Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:6379 -> 0.0.0.0:0: listen tcp 0.0.0.0:6379: bind: Only one usage of each socket address is normally permitted.",
		out: "",
	});
	expect(windows.port).toBe(6379);

	const down = dockerError("montage", {
		code: 1,
		err: "error during connect: Get http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/containers/json: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
		out: "",
	});
	expect(down.port).toBeNull();
	expect(down.message).toContain("Docker Desktop");

	// Newer Docker says it in other words (this one came after a restart of the computer).
	const newer = dockerError("montage", {
		code: 1,
		err: "unable to get image 'postgres:18': failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
		out: "",
	});
	expect(newer.message).toBe("Docker не отвечает: запустите Docker Desktop");

	const other = dockerError("montage", {
		code: 1,
		err: "some line\nenv file D:\\code\\montage\\apps\\server\\.env not found\n",
		out: "",
	});
	expect(other.message).toBe(
		"Docker montage не справился: env file D:\\code\\montage\\apps\\server\\.env not found"
	);
});

test("configured dev compose files override Docker's remembered production file and start only dependencies", () => {
	const [configured] = withCatalogue(parseDocker(LS, PS), [
		{
			file: "D:/code/gameradar/docker-compose.yml",
			name: "gameradar",
			overrides: ["D:/code/gameradar/docker-compose.dev.yml"],
			project: "gameradar",
			wanted: ["postgres", "redis"],
		},
	]);
	if (!configured) {
		throw new Error("missing project");
	}
	expect(composeArguments(configured, "up")).toEqual([
		"compose",
		"-p",
		"gameradar",
		"-f",
		"D:/code/gameradar/docker-compose.yml",
		"-f",
		"D:/code/gameradar/docker-compose.dev.yml",
		"up",
		"-d",
		"postgres",
		"redis",
	]);
});
