#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

function run() {
	const project = resolve(__dirname, "..");
	const settings = join(homedir(), ".devhub.json");
	const installed = existsSync(settings)
		? JSON.parse(readFileSync(settings, "utf8")).root
		: undefined;
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
	const root = candidates.find(
		(candidate) => candidate && existsSync(join(candidate, "src", "stage.ts"))
	);
	if (!root) {
		throw new Error(
			"Не найден DevHub: настройте DEVHUB_ROOT или ~/.devhub.json."
		);
	}
	const child = spawnSync(
		process.env.DEVHUB_BUN || "bun",
		[
			join(root, "src", "stage.ts"),
			...process.argv.slice(2),
			"--project",
			project,
		],
		{ stdio: "inherit", windowsHide: true }
	);
	if (child.error) {
		throw child.error;
	}
	return child.status ?? 1;
}

try {
	process.exitCode = run();
} catch (error) {
	process.stderr.write(`devhub worktree: ${error.message}\n`);
	process.exitCode = 1;
}
