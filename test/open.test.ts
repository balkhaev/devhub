import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	bringUp,
	type HubStarter,
	TRAY_START_EVENT,
	traySignalScript,
} from "../src/open";

const QUICK = { pollMs: 1, startMs: 40, trayMs: 40 };

/** A hub that begins to answer after the named step, with a tray that runs or not. */
function machine(
	tray: boolean,
	upAfter: "already" | "never" | "start" | "tray"
) {
	const calls: string[] = [];
	let up = upAfter === "already";
	const starter: HubStarter = {
		answers: () => Promise.resolve(up),
		askTray: () => {
			calls.push("tray");
			up ||= tray && upAfter === "tray";
			return Promise.resolve(tray);
		},
		start: () => {
			calls.push("start");
			up ||= upAfter === "start";
			return Promise.resolve();
		},
	};
	return { calls, starter };
}

test("a hub that answers is left alone", async () => {
	const { calls, starter } = machine(true, "already");
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual([]);
});

test("a running tray starts the hub: nothing is started from here", async () => {
	const { calls, starter } = machine(true, "tray");
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual(["tray"]);
});

test("without a tray the hub is started from here", async () => {
	const { calls, starter } = machine(false, "start");
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual(["tray", "start"]);
});

test("a tray whose hub does not come up is not waited for forever", async () => {
	const { calls, starter } = machine(true, "start");
	expect(await bringUp(starter, QUICK)).toBe(true);
	expect(calls).toEqual(["tray", "start"]);
});

test("a hub that never answers is reported, after one start", async () => {
	const { calls, starter } = machine(true, "never");
	expect(await bringUp(starter, QUICK)).toBe(false);
	expect(calls).toEqual(["tray", "start"]);
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
