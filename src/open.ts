import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadCatalogue } from "./config";
import { launchHidden } from "./processes";

/**
 * Opens the hub in the browser, first starting it in the background, hidden, when it does not answer yet (its
 * output goes to `.logs/hub.log`). This is what `Пульт.cmd` runs: one double click, no terminal to keep open.
 * With `--no-browser` it only makes sure the hub runs.
 */

const ROOT = resolve(dirname(import.meta.dir));
const WAIT_MS = 30_000;
const POLL_MS = 500;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function answers(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}api/health`, {
			signal: AbortSignal.timeout(1500),
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

/** Starts the hub hidden, on its own, so it outlives this script. */
async function startHiddenHub(): Promise<void> {
	const log = join(ROOT, ".logs", "hub.log");
	await mkdir(dirname(log), { recursive: true });
	if (process.platform !== "win32") {
		spawn(process.execPath, [join(ROOT, "src", "server.ts")], {
			cwd: ROOT,
			detached: true,
			stdio: "ignore",
		}).unref();
		return;
	}
	const batch = join(ROOT, ".state", "run", "hub.cmd");
	await mkdir(dirname(batch), { recursive: true });
	await writeFile(
		batch,
		[
			"@echo off",
			"chcp 65001 > nul",
			`cd /d "${ROOT}"`,
			`"${process.execPath}" src\\server.ts >> "${log}" 2>&1`,
			"",
		].join("\r\n")
	);
	await launchHidden(batch);
}

function openBrowser(url: string): void {
	if (process.platform === "win32") {
		spawn("cmd", ["/c", "start", "", url], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		}).unref();
		return;
	}
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

/** Whether the hub answers before the deadline, asking again every half second. */
async function waitFor(url: string, deadline: number): Promise<boolean> {
	if (await answers(url)) {
		return true;
	}
	if (Date.now() > deadline) {
		return false;
	}
	await sleep(POLL_MS);
	return waitFor(url, deadline);
}

export async function ensureHub(): Promise<string> {
	const catalogue = await loadCatalogue(join(ROOT, "services.json"));
	const address = `http://127.0.0.1:${catalogue.port}/`;
	if (!(await answers(address))) {
		await startHiddenHub();
		if (!(await waitFor(address, Date.now() + WAIT_MS))) {
			throw new Error(
				`Пульт не ответил: смотрите ${join(ROOT, ".logs", "hub.log")}`
			);
		}
	}
	return address;
}

if (import.meta.main) {
	const address = await ensureHub();
	process.stdout.write(`Пульт: ${address}\n`);
	if (!process.argv.includes("--no-browser")) {
		openBrowser(address);
	}
}
