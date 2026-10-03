#!/usr/bin/env node
"use strict";

// This file is copied into a project. It is used only by development scripts.
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { homedir } = require("node:os");
const {
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} = require("node:path");

const LINES = /\r?\n/;

function run() {
	const project = resolve(__dirname, "..");
	const [, , script] = process.argv;
	if (!script || process.argv.length > 3) {
		throw new Error(
			"Dev-параметры задаются в devhub.json; запускайте зарегистрированную команду без дополнительных аргументов."
		);
	}
	// A raw command may call another package's script. It stays in the hub's existing process tree.
	if (
		process.env.DEVHUB_ROOT &&
		process.env.DEVHUB_SERVICE &&
		ownedSource(project)
	) {
		const manifest = JSON.parse(
			readFileSync(join(project, "devhub.json"), "utf8")
		);
		const targets = manifest.launch?.[script] ?? [];
		if (
			targets.some(
				(target) =>
					(target.includes("/") ? target : `${manifest.id}/${target}`) ===
					process.env.DEVHUB_SERVICE
			)
		) {
			return runOwned(project, script);
		}
	}
	const root = findHub(project);
	if (!root) {
		throw new Error(
			'Для разработки нужен devhub. Укажите DEVHUB_ROOT или сохраните {"root":"путь к devhub"} в ~/.devhub.json. Production запускается собственной start/deploy-командой.'
		);
	}
	const child = spawnSync(
		process.env.DEVHUB_BUN || "bun",
		[
			join(root, "src", "cli.ts"),
			"start",
			"--project",
			project,
			"--script",
			script,
		],
		{ stdio: "inherit", windowsHide: true }
	);
	if (child.error) {
		throw child.error;
	}
	return child.status ?? 1;
}

function sourcePath(folder) {
	return realpathSync.native(resolve(folder));
}

function sameSource(a, b) {
	const normalize = (folder) =>
		process.platform === "win32"
			? sourcePath(folder).toLowerCase()
			: sourcePath(folder);
	return normalize(a) === normalize(b);
}

function inside(project, folder) {
	const path = relative(sourcePath(project), sourcePath(folder));
	return (
		path === "" ||
		!(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
	);
}

function primarySource(folder) {
	const git = spawnSync(
		"git",
		[
			"-C",
			folder,
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-dir",
			"--git-common-dir",
		],
		{ encoding: "utf8", windowsHide: true }
	);
	if (git.status !== 0) {
		return existsSync(join(folder, ".git")) ? null : folder;
	}
	const [top, dir, common] = git.stdout.trim().split(LINES);
	return top && dir && common && sameSource(dir, common) ? top : null;
}

function ownedSource(project) {
	const primary = primarySource(project);
	const cwdSource = primarySource(process.cwd());
	return (
		primary &&
		cwdSource &&
		sameSource(primary, project) &&
		inside(project, process.cwd()) &&
		inside(project, cwdSource) &&
		(!process.env.DEVHUB_PROJECT ||
			sameSource(project, process.env.DEVHUB_PROJECT))
	);
}

function runOwned(project, script) {
	const originals = JSON.parse(
		readFileSync(join(project, ".devhub", "original-scripts.json"), "utf8")
	);
	const packageFile = relative(
		project,
		join(process.cwd(), "package.json")
	).replaceAll("\\", "/");
	const scriptName =
		packageFile === "package.json"
			? script
			: script.slice(script.indexOf(":") + 1);
	const original = originals.packages?.[packageFile]?.[scriptName];
	if (!original || original.includes(".devhub/launch.cjs")) {
		throw new Error(
			`Не сохранена исходная команда ${script} для ${packageFile}`
		);
	}
	const child = spawnSync(original, {
		cwd: process.cwd(),
		env: process.env,
		shell: true,
		stdio: "inherit",
		windowsHide: true,
	});
	if (child.error) {
		throw child.error;
	}
	return child.status ?? 1;
}

function findHub(project) {
	let installed;
	const settings = join(homedir(), ".devhub.json");
	if (existsSync(settings)) {
		installed = JSON.parse(readFileSync(settings, "utf8")).root;
	}
	const candidates = [process.env.DEVHUB_ROOT, installed];
	let ancestor = project;
	do {
		candidates.push(join(ancestor, "devhub"));
		const parent = dirname(ancestor);
		if (parent === ancestor) {
			break;
		}
		ancestor = parent;
	} while (ancestor !== dirname(ancestor));
	return candidates.find(
		(candidate) =>
			candidate &&
			existsSync(join(candidate, "src", "cli.ts")) &&
			existsSync(join(candidate, "services.json"))
	);
}

try {
	process.exitCode = run();
} catch (error) {
	process.stderr.write(`devhub: ${error.message}\n`);
	process.exitCode = 1;
}
