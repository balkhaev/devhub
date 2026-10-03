import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { catalogueSchema } from "../src/config";
import { filesystemReferenceBlockers } from "../src/project-references";

const fixtures: string[] = [];
afterEach(async () => {
	for (const path of fixtures.splice(0)) {
		const absolute = resolve(path);
		const fromTemp = relative(resolve(tmpdir()), absolute);
		if (
			!basename(absolute).startsWith("devhub-references-") ||
			fromTemp.startsWith("..") ||
			isAbsolute(fromTemp)
		) {
			throw new Error("Fixture cleanup escaped its created temporary root");
		}
		// biome-ignore lint/performance/noAwaitInLoops: verify each created fixture boundary before removing it.
		await rm(absolute, { force: true, recursive: true });
	}
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "devhub-references-"));
	fixtures.push(root);
	const victim = join(root, "victim");
	const owner = join(root, "inference");
	await mkdir(join(victim, "data"), { recursive: true });
	await mkdir(owner);
	await writeFile(
		join(victim, "data", "shared.sqlite3"),
		"valuable shared data"
	);
	const catalogue = catalogueSchema.parse({
		code: root,
		projects: [
			{ id: "victim", name: "Victim", path: victim },
			{ id: "inference", name: "Inference", path: owner },
		],
	});
	const roots = [{ kind: "project" as const, path: victim }];
	const ownerProject = catalogue.projects.find(
		(project) => project.id === "inference"
	);
	if (!ownerProject) {
		throw new Error("Fixture owner is missing");
	}
	return { catalogue, owner, ownerProject, root, roots, victim };
}

test("indirect runtime TOML and escaped source literals protect shared backend files", async () => {
	const f = await fixture();
	await writeFile(
		join(f.owner, "inference.toml"),
		`[backends.comfy]\ncwd = ${JSON.stringify(join(f.victim, "data"))}\n`
	);
	await mkdir(join(f.owner, "src"));
	await writeFile(
		join(f.owner, "src", "backend.ts"),
		`export const root = ${JSON.stringify(f.victim)};\n`
	);
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(blockers.some((message) => message.includes("inference.toml"))).toBe(
		true
	);
	expect(blockers.some((message) => message.includes("backend.ts"))).toBe(true);
	expect(await readFile(join(f.victim, "data", "shared.sqlite3"), "utf8")).toBe(
		"valuable shared data"
	);
});

test("ignored root and app env files are inspected without exposing their secrets", async () => {
	const f = await fixture();
	const secret = "private-example-password-never-printed";
	await writeFile(join(f.owner, ".gitignore"), ".env*\n");
	await writeFile(
		join(f.owner, ".env.local"),
		`PASSWORD=${secret}\nSTATE=${join(f.victim, "data")}\n`
	);
	const app = join(f.owner, "apps", "server");
	await mkdir(app, { recursive: true });
	await writeFile(
		join(app, ".env"),
		`TOKEN=${secret}\nSTATE=${relative(app, join(f.victim, "data"))}\n`
	);
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(blockers.some((message) => message.includes(".env.local"))).toBe(true);
	expect(
		blockers.some((message) => message.includes(join("apps", "server", ".env")))
	).toBe(true);
	expect(blockers.join(" ")).not.toContain(secret);
});

test("relative Compose binds through a skipped runtime junction protect the external target", async () => {
	const f = await fixture();
	const runtime = join(f.owner, "runtime");
	await mkdir(runtime);
	const link = join(runtime, "shared");
	await symlink(
		join(f.victim, "data"),
		link,
		process.platform === "win32" ? "junction" : "dir"
	);
	await writeFile(
		join(f.owner, "compose.yaml"),
		"services:\n  api:\n    image: fixture\n    volumes:\n      - ./runtime/shared:/data\n      - type: bind\n        source: ../victim/data\n        target: /other\n"
	);
	f.ownerProject.compose = {
		file: "compose.yaml",
		overrides: [],
		project: "inference",
		services: ["api"],
	};
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(blockers.some((message) => message.includes(link))).toBe(true);
	expect(
		blockers.some(
			(message) =>
				message.includes("compose.yaml") && message.includes("использует файлы")
		)
	).toBe(true);
	expect(await readFile(join(f.victim, "data", "shared.sqlite3"), "utf8")).toBe(
		"valuable shared data"
	);
});

test("Compose interpolation uses local env paths and unresolved mounts fail closed", async () => {
	const f = await fixture();
	await writeFile(
		join(f.owner, ".env"),
		`DEVHUB_TEST_SHARED_PATH=${join(f.victim, "data")}\n`
	);
	await writeFile(
		join(f.owner, "compose.yaml"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture exercises Docker Compose environment interpolation.
		"services:\n  api:\n    volumes:\n      - ${DEVHUB_TEST_SHARED_PATH}:/data\n      - ${DEVHUB_TEST_UNKNOWN_MOUNT_72563}:/unknown\n"
	);
	f.ownerProject.compose = {
		file: "compose.yaml",
		overrides: [],
		project: "inference",
		services: [],
	};
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(
		blockers.some(
			(message) =>
				message.includes("compose.yaml") && message.includes(f.victim)
		)
	).toBe(true);
	expect(
		blockers.some((message) =>
			message.includes("проверка зависимостей не завершена")
		)
	).toBe(true);
});

test("owner policy links, documentation, historical tests and sibling path names are not runtime dependencies", async () => {
	const f = await fixture();
	await writeFile(join(f.owner, "AGENTS.md"), `Read ${f.victim}/AGENTS.md\n`);
	await mkdir(join(f.owner, "docs"));
	await writeFile(
		join(f.owner, "docs", "example.json"),
		JSON.stringify({ root: f.victim })
	);
	await mkdir(join(f.owner, "tests"));
	await writeFile(
		join(f.owner, "tests", "fixture.ts"),
		`const old = ${JSON.stringify(f.victim)};\n`
	);
	await mkdir(join(f.owner, "src"));
	await writeFile(
		join(f.owner, "src", "fixture.test.ts"),
		`const old = ${JSON.stringify(f.victim)};\n`
	);
	await writeFile(
		join(f.owner, "settings.json"),
		JSON.stringify({ root: `${f.victim}-old` })
	);
	expect(
		await filesystemReferenceBlockers(f.catalogue, "victim", f.roots)
	).toEqual([]);
});

test("escaped JavaScript regex paths do not trigger network filesystem probes", async () => {
	const f = await fixture();
	await writeFile(
		join(f.owner, "view.js"),
		String.raw`const pattern = /<link\b[^>]*href="\/assets\/game-cards\.css[^"]*">/g;`
	);
	expect(
		await filesystemReferenceBlockers(f.catalogue, "victim", f.roots)
	).toEqual([]);
});

test("package temporary archives skip payloads but retain incoming nested junction checks", async () => {
	const f = await fixture();
	const archive = join(
		f.owner,
		"apps",
		"server",
		"tmp",
		"archived",
		"backends"
	);
	await mkdir(archive, { recursive: true });
	await writeFile(
		join(archive, "browser.json"),
		"x".repeat(2 * 1024 * 1024 + 1)
	);
	const link = join(archive, "shared");
	await symlink(
		join(f.victim, "data"),
		link,
		process.platform === "win32" ? "junction" : "dir"
	);
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(blockers.some((message) => message.includes(link))).toBe(true);
	expect(blockers.some((message) => message.includes("не завершена"))).toBe(
		false
	);
});

test("oversized configuration and invalid Compose documents fail closed", async () => {
	const f = await fixture();
	await writeFile(
		join(f.owner, "settings.json"),
		"x".repeat(2 * 1024 * 1024 + 1)
	);
	await writeFile(join(f.owner, "compose.yaml"), "services: [unterminated\n");
	f.ownerProject.compose = {
		file: "compose.yaml",
		overrides: [],
		project: "inference",
		services: [],
	};
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(
		blockers.some((message) =>
			message.includes("проверка зависимостей не завершена")
		)
	).toBe(true);
	expect(
		blockers.some((message) => message.includes("Docker bind mounts"))
	).toBe(true);
});

test("source folders named models and data retain configuration inspection", async () => {
	const f = await fixture();
	const models = join(f.owner, "src", "models");
	const data = join(f.owner, "apps", "server", "data");
	await mkdir(models, { recursive: true });
	await mkdir(data, { recursive: true });
	await writeFile(
		join(models, "settings.ts"),
		`export const root = ${JSON.stringify(f.victim)};\n`
	);
	await writeFile(
		join(data, "config.json"),
		JSON.stringify({ source: f.victim })
	);
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(blockers.some((message) => message.includes("settings.ts"))).toBe(
		true
	);
	expect(blockers.some((message) => message.includes("config.json"))).toBe(
		true
	);
});

test("nested runtime junctions are inspected without scanning model data contents", async () => {
	const f = await fixture();
	const folder = join(f.owner, "runtime", "backends", "profiles");
	await mkdir(folder, { recursive: true });
	const link = join(folder, "h3-link");
	await symlink(
		join(f.victim, "data"),
		link,
		process.platform === "win32" ? "junction" : "dir"
	);
	await writeFile(
		join(folder, "weights.json"),
		"x".repeat(2 * 1024 * 1024 + 1)
	);
	const blockers = await filesystemReferenceBlockers(
		f.catalogue,
		"victim",
		f.roots
	);
	expect(blockers.some((message) => message.includes(link))).toBe(true);
	expect(blockers.some((message) => message.includes("не завершена"))).toBe(
		false
	);
});
