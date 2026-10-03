import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { primaryCheckout, sameSourcePath } from "../src/checkouts";

interface Repository {
	primary: string;
	worktrees: { exists: boolean; path: string }[];
}
interface Manifest {
	id: string;
	launch?: Record<string, string[]>;
}
interface Package {
	scripts?: Partial<Record<string, string>>;
	[key: string]: unknown;
}
interface Originals {
	packages: Record<string, Record<string, string>>;
	version: 1;
}
interface Edit {
	before: string | null;
	content: string;
	file: string;
}
interface Binding {
	canonical: string;
	launchers: number;
	packages: number;
	path: string;
	scripts: number;
}

const hub = resolve(import.meta.dir, "..");
const inventoryFile = join(hub, ".scratch", "worktree-inventory.json");
const backupRoot = join(
	hub,
	".state",
	"migrations",
	"worktrees-20261003",
	"worktree-bindings"
);
const write = process.argv.includes("--write");
const inventory = readJson<{ repos: Repository[] }>(inventoryFile);
const settings = readJson<{ aliases?: Record<string, string> }>(
	join(hub, "services.json")
);
const template = readFileSync(join(hub, "templates", "launch.cjs"), "utf8");
const edits = new Map<string, Edit>();
const bindings: Binding[] = [];
const blocked: { path: string; reason: string }[] = [];
const unmapped: { path: string; script: string }[] = [];
const DEV_SCRIPT = /(^|:)dev($|:)/;
const PRODUCTION_SCRIPT = /^(build|start|deploy)(:|$)/;
const EXPO_START = /^expo\s+start(?:\s|$)/;
const POTENTIAL_DEV = /(^|:)(studio|watch|serve|worker)($|:)/;
const WRAPPER_REFERENCE = /\.devhub[\\/]launch\.cjs/;
const LINES = /\r?\n/;
const LEGACY_LAUNCHERS: Record<string, string> = {
	"scripts/h3_local/studio_start.ps1": "dev:video",
	"scripts/laya_up.ps1": "dev:laya",
	"scripts/local_up.ps1": "dev:runtime",
	"scripts/local_up.sh": "dev:runtime",
	"scripts/qwen_image/start.ps1": "dev:generation",
	"scripts/start_zemstroy.ps1": "dev:zemstroy",
	"scripts/start.ps1": "dev:queue",
};

function slash(value: string) {
	return value.replaceAll("\\", "/");
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

function serialize(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function plan(file: string, content: string) {
	const before = existsSync(file) ? readFileSync(file, "utf8") : null;
	if (before !== content) {
		edits.set(file, { before, content, file });
	}
}

function canonical(primary: string) {
	const alias = Object.entries(settings.aliases ?? {}).find(([from]) =>
		sameSourcePath(from, primary)
	);
	return alias ? primaryCheckout(alias[1]) : primaryCheckout(primary);
}

const knownLaunchers = new Set([digest(template)]);
for (const repo of inventory.repos) {
	const primary = canonical(repo.primary);
	for (const name of ["launch.cjs", "original-launch.cjs"]) {
		const file = join(primary, ".devhub", name);
		if (existsSync(file)) {
			knownLaunchers.add(digest(readFileSync(file, "utf8")));
		}
	}
}

function packageFiles(folder: string) {
	const result = spawnSync(
		"rg",
		[
			"--files",
			"--hidden",
			"-g",
			"package.json",
			"-g",
			"!**/node_modules/**",
			"-g",
			"!**/.git/**",
			"-g",
			"!**/.venv/**",
			"-g",
			"!**/.agents/**",
			"-g",
			"!**/.claude/**",
			"-g",
			"!**/.codex/**",
			"-g",
			"!**/.worktrees/**",
			"-g",
			"!**/dist/**",
			"-g",
			"!**/.next/**",
			"-g",
			"!**/fixtures/**",
			".",
		],
		{ cwd: folder, encoding: "utf8", windowsHide: true }
	);
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0 && result.status !== 1) {
		throw new Error(result.stderr || "Package discovery failed");
	}
	return result.stdout
		.trim()
		.split(LINES)
		.filter(Boolean)
		.map((file) => resolve(folder, file));
}

function validateOriginal(
	file: string,
	key: string,
	current: string,
	original: string | undefined,
	managed: string
) {
	if (original && WRAPPER_REFERENCE.test(original)) {
		throw new Error(`${file}: saved original ${key} is itself a wrapper`);
	}
	if (WRAPPER_REFERENCE.test(current)) {
		if (current !== managed || !original) {
			throw new Error(
				`${file}: unrecognized wrapper or missing original for ${key}`
			);
		}
	} else if (original && current !== original) {
		throw new Error(
			`${file}: ${key} differs from its saved original; preserve drift before binding`
		);
	}
}

function scriptLaunch(
	file: string,
	relFolder: string,
	key: string,
	current: string,
	original: string | undefined,
	manifest: Manifest
) {
	const launch = relFolder ? `${relFolder}:${key}` : key;
	const mapped = Object.hasOwn(manifest.launch ?? {}, launch);
	const expo =
		key === "start" && mapped && EXPO_START.test(original ?? current);
	if (PRODUCTION_SCRIPT.test(key) && !expo) {
		return null;
	}
	if (DEV_SCRIPT.test(key) || mapped) {
		return launch;
	}
	if (
		POTENTIAL_DEV.test(key) &&
		!key.startsWith("db:") &&
		!key.startsWith("redis:")
	) {
		unmapped.push({ path: file, script: key });
	}
	return null;
}

function bindPackage(
	folder: string,
	file: string,
	manifest: Manifest,
	originals: Originals,
	record: Binding
) {
	const pkg = readJson<Package>(file);
	const relFile = slash(relative(folder, file));
	const relFolder = slash(relative(folder, dirname(file)));
	const scripts = { ...pkg.scripts };
	let changedPackage = false;
	for (const [key, current] of Object.entries(scripts)) {
		if (typeof current !== "string") {
			continue;
		}
		const original = originals.packages[relFile]?.[key];
		const launch = scriptLaunch(
			file,
			relFolder,
			key,
			current,
			original,
			manifest
		);
		if (!launch) {
			continue;
		}
		const managed = `node ${slash(relative(dirname(file), join(folder, ".devhub", "launch.cjs")))} ${launch}`;
		validateOriginal(file, key, current, original, managed);
		originals.packages[relFile] ??= {};
		const saved = originals.packages[relFile];
		if (!saved) {
			throw new Error(`${file}: missing originals entry`);
		}
		saved[key] ??= current;
		scripts[key] = managed;
		record.scripts += 1;
		changedPackage ||= managed !== current;
	}
	if (changedPackage) {
		pkg.scripts = scripts;
		plan(file, serialize(pkg));
		record.packages += 1;
	}
}

function bindPackages(folder: string, manifest: Manifest, record: Binding) {
	const originalsFile = join(folder, ".devhub", "original-scripts.json");
	const originals: Originals = existsSync(originalsFile)
		? readJson<Originals>(originalsFile)
		: { packages: {}, version: 1 };
	if (originals.version !== 1 || !originals.packages) {
		throw new Error(`${originalsFile}: unrecognized original-scripts format`);
	}
	for (const file of packageFiles(folder)) {
		bindPackage(folder, file, manifest, originals, record);
	}
	if (record.scripts) {
		plan(originalsFile, serialize(originals));
	}
}

function fallbackLauncher(relativeFile: string, script: string) {
	if (relativeFile.endsWith(".sh")) {
		return `#!/usr/bin/env bash\nset -euo pipefail\nexec node "$(dirname "$0")/../.devhub/launch.cjs" ${script} "$@"\n`;
	}
	const location = slash(relative(dirname(relativeFile), ".devhub/launch.cjs"));
	if (relativeFile === "scripts/local_up.ps1") {
		return `if ($args.Count -gt 0) { throw "Set local runtime parameters in devhub.json; prepare requirements separately." }\n$ErrorActionPreference = 'Stop'\n& node (Join-Path $PSScriptRoot '${location}') '${script}'\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nexit 0\n`;
	}
	return `$ErrorActionPreference = 'Stop'\nif ($args.Count -gt 0) { throw 'Development parameters belong to canonical devhub.json.' }\n& node (Join-Path $PSScriptRoot '${location}') '${script}'\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nexit 0\n`;
}

function bindLocalLaunchers(
	folder: string,
	primary: string,
	manifest: Manifest,
	record: Binding
) {
	const originalsFile = join(folder, ".devhub", "original-launchers.json");
	const originals = existsSync(originalsFile)
		? readJson<Record<string, string>>(originalsFile)
		: {};
	for (const [relFile, script] of Object.entries(LEGACY_LAUNCHERS)) {
		const file = join(folder, relFile);
		if (!existsSync(file)) {
			continue;
		}
		// A known dev launcher must route to canonical even when this version no longer exposes it.
		const primaryFile = join(primary, relFile);
		const canonicalContent = existsSync(primaryFile)
			? readFileSync(primaryFile, "utf8")
			: null;
		const content =
			canonicalContent && WRAPPER_REFERENCE.test(canonicalContent)
				? canonicalContent
				: fallbackLauncher(relFile, script);
		const current = readFileSync(file, "utf8");
		validateOriginal(file, relFile, current, originals[relFile], content);
		originals[relFile] ??= current;
		plan(file, content);
		record.launchers += 1;
		if (!Object.hasOwn(manifest.launch ?? {}, script)) {
			unmapped.push({ path: file, script });
		}
	}
	if (record.launchers) {
		plan(originalsFile, serialize(originals));
	}
}

for (const repo of inventory.repos) {
	const primary = canonical(repo.primary);
	const manifestFile = join(primary, "devhub.json");
	if (!existsSync(manifestFile)) {
		continue;
	}
	const manifest = readJson<Manifest>(manifestFile);
	for (const tree of repo.worktrees) {
		if (
			!(tree.exists && existsSync(join(tree.path, ".git"))) ||
			sameSourcePath(primary, tree.path)
		) {
			continue;
		}
		const folder = resolve(tree.path);
		const record: Binding = {
			canonical: primary,
			launchers: 0,
			packages: 0,
			path: folder,
			scripts: 0,
		};
		try {
			const launcherFile = join(folder, ".devhub", "launch.cjs");
			if (
				existsSync(launcherFile) &&
				!knownLaunchers.has(digest(readFileSync(launcherFile, "utf8")))
			) {
				throw new Error(`${launcherFile}: launcher has unrecognized drift`);
			}
			bindPackages(folder, manifest, record);
			bindLocalLaunchers(folder, primary, manifest, record);
			plan(launcherFile, template);
			bindings.push(record);
		} catch (error) {
			blocked.push({
				path: folder,
				reason: error instanceof Error ? error.message : "Binding failed",
			});
		}
	}
}

// Preflight every file before writes so a concurrently edited launcher is never overwritten.
if (write && !blocked.length) {
	for (const edit of edits.values()) {
		const current = existsSync(edit.file)
			? readFileSync(edit.file, "utf8")
			: null;
		if (current !== edit.before) {
			blocked.push({
				path: edit.file,
				reason: "File changed during binding preflight",
			});
		}
	}
}
if (write && !blocked.length) {
	mkdirSync(backupRoot, { recursive: true });
	for (const edit of edits.values()) {
		const backupFile = join(
			backupRoot,
			`${digest(edit.file.toLowerCase())}.json`
		);
		if (!existsSync(backupFile)) {
			writeFileSync(
				backupFile,
				serialize({
					content: edit.before,
					existed: edit.before !== null,
					path: edit.file,
				})
			);
		}
		mkdirSync(dirname(edit.file), { recursive: true });
		writeFileSync(edit.file, edit.content);
	}
}
const report = {
	bindings,
	blocked,
	checkouts: bindings.length,
	launchers: bindings.reduce((total, binding) => total + binding.launchers, 0),
	mode: write ? "write" : "dry-run",
	modifiedFiles: write && !blocked.length ? edits.size : 0,
	plannedFiles: edits.size,
	scripts: bindings.reduce((total, binding) => total + binding.scripts, 0),
	unmapped,
};
if (write && !blocked.length) {
	writeFileSync(join(backupRoot, "report.json"), serialize(report));
}
process.stdout.write(serialize(report));
if (blocked.length) {
	process.exitCode = 1;
}
