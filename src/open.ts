import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appViewOwner } from "./app-view";
import { primaryCheckout } from "./checkouts";
import { loadCatalogue } from "./config";
import { capture } from "./probes";
import { launchHidden, launchOutside } from "./processes";

/**
 * Opens the hub in the browser, first starting it in the background, hidden, when it does not answer yet (its
 * output goes to `.logs/hub.log`). This is what `Пульт.cmd` runs: one double click, no terminal to keep open.
 * With `--no-browser` it only makes sure the hub runs.
 *
 * On Windows it matters who starts the hub: it and every service it starts keep the starter's view of
 * `%LOCALAPPDATA%`, and a process of an agent's desktop app has a private one (`app-view.ts`). So the tray is asked
 * first: it runs in the person's own session and starts the hub there. Without a tray the hub is started from
 * here, through the desktop shell when this process lives in an app's view, so that the hub does not.
 */

const ROOT = primaryCheckout(resolve(dirname(import.meta.dir)));
/** The tray's named event that means «start the hub now» (`Signals.Start` in `tray/Tray.cs`). */
export const TRAY_START_EVENT = "Local\\DevhubTray.Start";
const SIGNAL_MS = 20_000;

/**
 * What the hub's address says. Its server is up within seconds, yet the hub is ready only once it has taken stock
 * of the computer, which takes half a minute with many services: until then it is `starting`.
 */
export type HubState = "ready" | "silent" | "starting";

/**
 * How long to wait for the hub: between two asks, for a starting hub to become ready, and for the tray's hub to
 * show up after the tray was asked.
 */
export interface Patience {
	pollMs: number;
	readyMs: number;
	trayMs: number;
}

const PATIENCE: Patience = { pollMs: 500, readyMs: 90_000, trayMs: 15_000 };

/** The three things bringing the hub up consists of. */
export interface HubStarter {
	/** Asks the running tray to start the hub; false when there is no tray to ask. */
	askTray: () => Promise<boolean>;
	/** Starts the hub hidden, on its own, so it outlives this script. */
	start: () => Promise<void>;
	/** What the hub's address says now. */
	state: () => Promise<HubState>;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function hubState(url: string): Promise<HubState> {
	try {
		const response = await fetch(`${url}api/health`, {
			signal: AbortSignal.timeout(1500),
		});
		await response.body?.cancel();
		if (response.ok) {
			return "ready";
		}
		// The hub's own word for «still starting»; anything else on this port is not the hub.
		return response.status === 503 ? "starting" : "silent";
	} catch {
		return "silent";
	}
}

/** The PowerShell that sets the tray's event; it prints whether a tray that knows the event runs. */
export function traySignalScript(): string {
	return [
		`try { $signal = [System.Threading.EventWaitHandle]::OpenExisting('${TRAY_START_EVENT}')`,
		"[void]$signal.Set()",
		"$signal.Dispose()",
		"'asked' } catch { 'absent' }",
	].join("; ");
}

async function askTray(): Promise<boolean> {
	if (process.platform !== "win32") {
		return false;
	}
	const out = await capture(
		"powershell",
		["-NoProfile", "-NonInteractive", "-Command", traySignalScript()],
		SIGNAL_MS
	);
	return out.trim() === "asked";
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
	const owner = appViewOwner();
	if (!owner) {
		await launchHidden(batch);
		return;
	}
	try {
		await launchOutside(batch);
	} catch (error) {
		throw new Error(
			`Не удалось запустить пульт вне приложения ${owner} (${(error as Error).message}). Запустите его значком в трее или ярлыком «Пульт» на рабочем столе.`,
			{ cause: error }
		);
	}
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

/** Whether the hub gets to the wanted state before the deadline, asking again after every pause. */
async function waitFor(
	starter: HubStarter,
	wanted: (state: HubState) => boolean,
	deadline: number,
	pollMs: number
): Promise<boolean> {
	if (wanted(await starter.state())) {
		return true;
	}
	if (Date.now() > deadline) {
		return false;
	}
	await sleep(pollMs);
	return waitFor(starter, wanted, deadline, pollMs);
}

/**
 * Makes the hub ready. A silent one is started: the tray is asked and given time to show its hub; when there is no
 * tray, or its hub did not show up, the hub is started from here. A hub that is starting, whoever started it, is
 * only waited for: a second copy would lose the port to it. Returns whether the hub is ready in the end.
 */
export async function bringUp(
	starter: HubStarter,
	patience: Patience = PATIENCE
): Promise<boolean> {
	const found = await starter.state();
	if (found === "ready") {
		return true;
	}
	if (found === "silent") {
		const shown =
			(await starter.askTray()) &&
			(await waitFor(
				starter,
				(state) => state !== "silent",
				Date.now() + patience.trayMs,
				patience.pollMs
			));
		if (!shown) {
			await starter.start();
		}
	}
	return waitFor(
		starter,
		(state) => state === "ready",
		Date.now() + patience.readyMs,
		patience.pollMs
	);
}

export async function ensureHub(): Promise<string> {
	const catalogue = await loadCatalogue(join(ROOT, "services.json"));
	const address = `http://127.0.0.1:${catalogue.port}/`;
	const up = await bringUp({
		askTray,
		start: startHiddenHub,
		state: () => hubState(address),
	});
	if (!up) {
		throw new Error(
			`Пульт не ответил: смотрите ${join(ROOT, ".logs", "hub.log")}`
		);
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
