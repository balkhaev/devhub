import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
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

async function fixture(withAlias = false) {
	const root = await mkdtemp(join(tmpdir(), "devhub-project-boundaries-"));
	fixtures.push(root);
	const hubRoot = join(root, "hub");
	const code = join(root, "code");
	const app = join(code, "app");
	const alias = join(code, "legacy");
	const file = join(hubRoot, "services.json");
	await mkdir(hubRoot);
	await mkdir(app, { recursive: true });
	await writeFile(join(app, "private.txt"), "reviewed fixture data");
	if (withAlias) {
		await mkdir(alias);
		await writeFile(join(alias, "private.txt"), "legacy fixture data");
	}
	await writeFile(
		file,
		JSON.stringify({
			aliases: withAlias ? { [alias]: app } : {},
			code,
			projects: [{ id: "app", name: "App", path: app }],
		})
	);
	const hub = new Hub(await loadCatalogue(file), hubRoot, {
		dockerView: async () => ({ available: false, projects: [] }),
		listeningPorts: async () => new Map(),
		listeningPortsV6: async () => new Map(),
	});
	await hub.refresh(true);
	return {
		alias,
		app,
		code,
		file,
		hubRoot,
		manager: new Projects(hub, hubRoot),
		root,
	};
}

async function installStagePolicy(folder: string) {
	const git = spawnSync("git", ["-C", folder, "init", "-b", "stage"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (git.status !== 0) {
		throw new Error(git.stderr);
	}
	await mkdir(join(folder, ".devhub"));
	await writeFile(
		join(folder, ".devhub/worktree.json"),
		JSON.stringify({
			checks: [],
			releaseBranch: "main",
			stageBranch: "stage",
			version: 1,
			worktreeRoot: "../tasks",
		})
	);
}

interface JournalHook {
	record: (id: string, paths: unknown, status: string) => Promise<void>;
}

function beforeFirstMove(manager: Projects, action: () => Promise<void>) {
	const hook = manager as unknown as JournalHook;
	const original = hook.record.bind(manager);
	hook.record = async (id, paths, status) => {
		await original(id, paths, status);
		if (status === "preparing") {
			await action();
		}
	};
}

test("a standalone alias's stage lock protects its files during project deletion", async () => {
	const f = await fixture(true);
	await installStagePolicy(f.app);
	await installStagePolicy(f.alias);
	const plan = await f.manager.plan("app");
	expect(plan.blockers).toEqual([]);
	const stage = new StageProject(f.alias, join(f.hubRoot, ".state/stage"));
	const release = stage.acquireLock();
	try {
		await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
			"stage-процессом"
		);
		expect(await readFile(join(f.app, "private.txt"), "utf8")).toBe(
			"reviewed fixture data"
		);
		expect(await readFile(join(f.alias, "private.txt"), "utf8")).toBe(
			"legacy fixture data"
		);
	} finally {
		release();
	}
});

test("stage owners from different DevHub state directories serialize the same repository", async () => {
	const f = await fixture();
	await installStagePolicy(f.app);
	const canonical = new StageProject(f.app, join(f.hubRoot, ".state/stage"));
	const worktreeCli = new StageProject(
		f.app,
		join(f.root, "other-hub/.state/stage")
	);
	const release = canonical.acquireLock();
	let releaseOther: (() => void) | undefined;
	try {
		expect(() => {
			releaseOther = worktreeCli.acquireLock();
		}).toThrow("stage-процессом");
	} finally {
		releaseOther?.();
		release();
	}
	expect(existsSync(f.app)).toBe(true);
});

test("a folder replacement after final review and immediately before preparation is preserved", async () => {
	const f = await fixture();
	const saved = join(f.code, "app-reviewed");
	const plan = await f.manager.plan("app");
	beforeFirstMove(f.manager, async () => {
		await rename(f.app, saved);
		await mkdir(f.app);
		await writeFile(join(f.app, "unrelated.txt"), "replacement fixture data");
	});
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
		"Папка изменилась"
	);
	expect(await readFile(join(saved, "private.txt"), "utf8")).toBe(
		"reviewed fixture data"
	);
	expect(await readFile(join(f.app, "unrelated.txt"), "utf8")).toBe(
		"replacement fixture data"
	);
	expect(
		(await loadCatalogue(f.file)).projects.map((project) => project.id)
	).toEqual(["app"]);
});

test("a late catalogue conflict rolls back every moved root and keeps the unrelated edit", async () => {
	const f = await fixture(true);
	const plan = await f.manager.plan("app");
	beforeFirstMove(f.manager, async () => {
		const policy = JSON.parse(await readFile(f.file, "utf8"));
		policy.projects[0].name = "Concurrent catalogue edit";
		await writeFile(f.file, JSON.stringify(policy));
	});
	await expect(f.manager.delete("app", plan.token)).rejects.toThrow(
		"services.json изменился"
	);
	expect(await readFile(join(f.app, "private.txt"), "utf8")).toBe(
		"reviewed fixture data"
	);
	expect(await readFile(join(f.alias, "private.txt"), "utf8")).toBe(
		"legacy fixture data"
	);
	expect((await loadCatalogue(f.file)).projects[0]?.name).toBe(
		"Concurrent catalogue edit"
	);
});

test("catalogue edits during temporary file creation are not silently overwritten", async () => {
	const f = await fixture();
	const plan = await f.manager.plan("app");
	const edited = {
		...JSON.parse(readFileSync(f.file, "utf8")),
		exclude: [join(f.code, "other")],
	};
	let injected = false;
	const watcher = watch(f.hubRoot, (_event, filename) => {
		if (!injected && filename?.toString().endsWith(".tmp")) {
			injected = true;
			writeFileSync(f.file, JSON.stringify(edited));
		}
	});
	try {
		await f.manager.delete("app", plan.token).catch(() => undefined);
	} finally {
		watcher.close();
	}
	expect(injected).toBe(true);
	expect((await loadCatalogue(f.file)).exclude).toContain(
		join(f.code, "other")
	);
});
