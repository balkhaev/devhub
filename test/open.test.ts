import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "bun";

import {
	bringUp,
	type HubStarter,
	type HubState,
	hubState,
	TRAY_START_EVENT,
	traySignalScript,
} from "../src/open";

/** Readiness takes longer than the time the tray is given to show its hub. */
const READY_AFTER_MS = 150;
const QUICK = { pollMs: 1, readyMs: 5000, trayMs: 40 };

/** A hub that a tray, this script, both or nobody can start; once started it is ready a moment later. */
function machine(options: {
	hub?: HubState;
	own?: boolean;
	tray?: "idle" | "starts";
}) {
	const calls: string[] = [];
	let state: HubState = options.hub ?? "silent";
	let readyAt = state === "starting" ? Date.now() + READY_AFTER_MS : 0;
	const begin = () => {
		state = "starting";
		readyAt = Date.now() + READY_AFTER_MS;
	};
	const starter: HubStarter = {
		askTray: () => {
			calls.push("tray");
			if (options.tray === "starts") {
				begin();
			}
			return Promise.resolve(options.tray !== undefined);
		},
		start: () => {
			calls.push("start");
			if (options.own) {
				begin();
			}
			return Promise.resolve();
		},
		state: () => {
			if (state === "starting" && Date.now() >= readyAt) {
				state = "ready";
			}
			return Promise.resolve(state);
		},
	};
	return { calls, starter };
}

test("a ready hub is left alone", async () => {
	const { calls, starter } = machine({ hub: "ready" });
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual([]);
});

test("a hub that is starting is waited for: nobody starts a second copy", async () => {
	const { calls, starter } = machine({ hub: "starting", own: true });
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual([]);
});

test("a running tray starts the hub, and its hub is given the time to get ready", async () => {
	const { calls, starter } = machine({ own: true, tray: "starts" });
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual(["tray"]);
});

test("without a tray the hub is started from here", async () => {
	const { calls, starter } = machine({ own: true });
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual(["tray", "start"]);
});

test("a tray whose hub does not show up is not waited for forever", async () => {
	const { calls, starter } = machine({ own: true, tray: "idle" });
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual(["tray", "start"]);
});

test("a hub that never gets ready is reported, after one start", async () => {
	const { calls, starter } = machine({ tray: "idle" });
	expect(await bringUp(starter, { ...QUICK, readyMs: 60 })).toBe(false);
	expect(calls).toEqual(["tray", "start"]);
});

test("the hub's address says ready, starting, or nothing of the hub", async () => {
	let status = 503;
	const server = serve({
		fetch: () => Response.json({ app: "devhub" }, { status }),
		hostname: "127.0.0.1",
		port: 0,
	});
	const address = `http://127.0.0.1:${server.port}/`;
	try {
		expect(await hubState(address)).toBe("starting");
		status = 200;
		expect(await hubState(address)).toBe("ready");
		// Another program on the hub's port.
		status = 404;
		expect(await hubState(address)).toBe("silent");
	} finally {
		await server.stop(true);
	}
	expect(await hubState(address)).toBe("silent");
});

test("the tray is asked through the event it listens on", () => {
	expect(traySignalScript()).toContain(`::OpenExisting('${TRAY_START_EVENT}')`);
	const tray = readFileSync(
		join(import.meta.dir, "..", "tray", "Tray.cs"),
		"utf8"
	);
	expect(tray).toContain(
		`public const string Start = ${JSON.stringify(TRAY_START_EVENT)};`
	);
});
