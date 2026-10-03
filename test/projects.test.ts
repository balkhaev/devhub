import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalogue } from "../src/config";
import { Hub } from "../src/hub";
import { Projects } from "../src/projects";
import { StageProject } from "../src/stage";

const fixtures: string[] = [];
afterEach(async () => {
	await Promise.all(
		fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true }))
	);
});

async function fixture(extra: unknown[] = []) {
	const root = await mkdtemp(join(tmpdir(), "devhub-projects-"));
	fixtures.push(root);
	const hubRoot = join(root, "hub");
	const code = join(root, "code");
	const app = join(code, "app");
	const file = join(hubRoot, "services.json");
	await mkdir(app, { recursive: true });
	await mkdir(hubRoot, { recursive: true });
	await writeFile(join(app, "private.txt"), "untracked work and local data");
	await writeFile(
		file,
		JSON.stringify({
			code,
			projects: [{ id: "app", name: "App", path: app }, ...extra],
		})
	);
	const hub = new Hub(await loadCatalogue(file), hubRoot, {
		dockerView: async () => ({ available: false, projects: [] }),
		listeningPorts: async () => new Map(),
		listeningPortsV6: async () => new Map(),
	});
	await hub.refresh();
	return {
		app,
		code,
		file,
		hub,
		hubRoot,
		manager: new Projects(hub, hubRoot),
		root,
	};
}

function git(path: string, ...args: string[]) {
	const result = spawnSync("git", ["-C", path, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr);
	}
	return result.stdout;
}

test("reviewed deletion removes real files and refreshes the catalogue, and cannot be replayed", async () => {
	const f = await fixture();
	const plan = await f.manager.plan("app");
	expect(plan.blockers).toEqual([]);
	expect(plan.paths).toEqual([{ kind: "project", path: f.app }]);
	await f.manager.delete("app", plan.token);
	expect(existsSync(f.app)).toBe(false);
	expect(f.hub.current.projects).toEqual([]);
	expect((await loadCatalogue(f.file)).projects).toEqual([]);
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow("устарел");
	expect(
		JSON.parse(
			await readFile(join(f.hubRoot, ".state/deletions/app.json"), "utf8")
		).status
	).toBe("deleted");
});

test("all existing Git worktrees and a registered standalone alias are included and removed", async () => {
	const f = await fixture();
	git(f.app, "init", "-b", "stage");
	git(
		f.app,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"add",
		"private.txt"
	);
	git(
		f.app,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"commit",
		"-m",
		"fixture"
	);
	const worktree = join(f.root, "task");
	git(f.app, "worktree", "add", "-b", "codex/task", worktree);
	const alias = join(f.root, "legacy");
	await mkdir(alias);
	await writeFile(join(alias, "data.sqlite"), "local data");
	const policy = JSON.parse(await readFile(f.file, "utf8"));
	policy.aliases = { [alias]: f.app };
	policy.discover = [f.root];
	await writeFile(f.file, JSON.stringify(policy));
	const plan = await f.manager.plan("app");
	expect(plan.paths.map((path) => path.kind).sort()).toEqual([
		"alias",
		"project",
		"worktree",
	]);
	await f.manager.delete("app", plan.token);
	expect([f.app, alias, worktree].some(existsSync)).toBe(false);
});

test("nested junction deletion preserves external data", async () => {
	const f = await fixture();
	const data = join(f.root, "shared-models");
	await mkdir(data);
	await writeFile(join(data, "weights.bin"), "valuable shared weights");
	await symlink(
		data,
		join(f.app, "models"),
		process.platform === "win32" ? "junction" : "dir"
	);
	const plan = await f.manager.plan("app");
	await f.manager.delete("app", plan.token);
	expect(await readFile(join(data, "weights.bin"), "utf8")).toBe(
		"valuable shared weights"
	);
});

test("changed folder identity or machine catalogue invalidates an approved plan", async () => {
	const f = await fixture();
	const plan = await f.manager.plan("app");
	await rename(f.app, `${f.app}-original`);
	await mkdir(f.app);
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
		"изменился"
	);
	expect(existsSync(`${f.app}-original/private.txt`)).toBe(true);
	expect(existsSync(f.app)).toBe(true);
	const fresh = await f.manager.plan("app");
	await writeFile(f.file, `${await readFile(f.file, "utf8")}\n`);
	await expect(f.manager.delete("app", fresh.token)).rejects.toThrow(
		"изменился"
	);
});

test("cross-project service and data dependencies block removal", async () => {
	const f = await fixture();
	const other = join(f.code, "other");
	await mkdir(other);
	const policy = JSON.parse(await readFile(f.file, "utf8"));
	policy.projects[0].services = [{ id: "api", name: "API" }];
	policy.projects.push({
		id: "other",
		name: "Other",
		path: other,
		services: [
			{
				env: { DATA: join(f.app, "private.txt") },
				id: "web",
				name: "Web",
				needs: ["app/api"],
			},
		],
	});
	await writeFile(f.file, JSON.stringify(policy));
	const plan = await f.manager.plan("app");
	expect(plan.blockers.join(" ")).toContain("зависит от app/api");
	expect(plan.blockers.join(" ")).toContain("использует файлы");
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow("зависит");
	expect(existsSync(f.app)).toBe(true);
});

test("DevHub and catalogue roots are protected even if explicitly configured as a project", async () => {
	const f = await fixture();
	const policy = JSON.parse(await readFile(f.file, "utf8"));
	policy.projects[0].path = f.hubRoot;
	await writeFile(f.file, JSON.stringify(policy));
	const plan = await f.manager.plan("app");
	expect(plan.blockers.join(" ")).toContain("DevHub");
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow("DevHub");
	expect(existsSync(f.file)).toBe(true);
});

test("an explicitly configured unrelated folder outside project collections is protected", async () => {
	const f = await fixture();
	const unrelated = join(f.root, "unrelated-personal-folder");
	await mkdir(unrelated);
	const policy = JSON.parse(await readFile(f.file, "utf8"));
	policy.projects[0].path = unrelated;
	await writeFile(f.file, JSON.stringify(policy));
	const plan = await f.manager.plan("app");
	expect(plan.blockers.join(" ")).toContain("вне коллекций");
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
		"вне коллекций"
	);
	expect(existsSync(unrelated)).toBe(true);
});

test("the stage lifecycle lock prevents deletion during worktree integration", async () => {
	const f = await fixture();
	git(f.app, "init", "-b", "stage");
	await mkdir(join(f.app, ".devhub"));
	await writeFile(
		join(f.app, ".devhub/worktree.json"),
		JSON.stringify({
			checks: [],
			releaseBranch: "main",
			stageBranch: "stage",
			version: 1,
			worktreeRoot: "../tasks",
		})
	);
	const plan = await f.manager.plan("app");
	const project = new StageProject(f.app, join(f.hubRoot, ".state/stage"));
	const release = project.acquireLock();
	try {
		await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
			"stage-процессом"
		);
		expect(existsSync(f.app)).toBe(true);
	} finally {
		release();
	}
	await f.manager.delete("app", (await f.manager.plan("app")).token);
	expect(existsSync(f.app)).toBe(false);
});

test("a task registration replaced by an unrelated directory cannot authorize deletion", async () => {
	const f = await fixture();
	git(f.app, "init", "-b", "stage");
	git(f.app, "add", "private.txt");
	git(
		f.app,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"commit",
		"-m",
		"fixture"
	);
	const task = join(f.root, "task");
	git(f.app, "worktree", "add", "-b", "codex/task", task);
	await rename(task, `${task}-saved`);
	await mkdir(task);
	await writeFile(join(task, "unrelated.txt"), "keep");
	const plan = await f.manager.plan("app");
	expect(plan.blockers.join(" ")).toContain("другую папку");
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
		"другую папку"
	);
	expect(await readFile(join(task, "unrelated.txt"), "utf8")).toBe("keep");
});

test("launches remain blocked while a project is quiesced", async () => {
	const f = await fixture();
	const policy = JSON.parse(await readFile(f.file, "utf8"));
	policy.projects[0].services = [
		{ command: "never-run", id: "api", name: "API" },
	];
	await writeFile(f.file, JSON.stringify(policy));
	await f.hub.replaceCatalogue(await loadCatalogue(f.file));
	const release = await f.hub.quiesceProject("app");
	await expect(f.hub.startService("app/api")).rejects.toThrow("удаляется");
	release();
});

test("quiescing waits for an in-flight Docker up and rejects subsequent up requests", async () => {
	const f = await fixture();
	const policy = JSON.parse(await readFile(f.file, "utf8"));
	policy.projects[0].compose = { file: "compose.yaml", project: "app" };
	await writeFile(f.file, JSON.stringify(policy));
	await writeFile(join(f.app, "compose.yaml"), "services: {}\n");
	const { promise: started, resolve: began } = Promise.withResolvers<void>();
	const { promise: pending, resolve: complete } = Promise.withResolvers<void>();
	const hub = new Hub(await loadCatalogue(f.file), f.hubRoot, {
		composeAction: async () => {
			began();
			await pending;
		},
		dockerView: async () => ({ available: true, projects: [] }),
		listeningPorts: async () => new Map(),
		listeningPortsV6: async () => new Map(),
	});
	await hub.refresh(true);
	const up = hub.composeAction("app", "up");
	await started;
	let quiesced = false;
	const stopping = hub.quiesceProject("app").then((unblock) => {
		quiesced = true;
		return unblock;
	});
	await Promise.resolve();
	expect(quiesced).toBe(false);
	await expect(hub.composeAction("app", "up")).rejects.toThrow("удаляется");
	complete();
	await up;
	const release = await stopping;
	expect(quiesced).toBe(true);
	release();
});
