import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalogueSchema } from "../src/config";
import { Processes } from "../src/processes";
import { startHub } from "../src/server";

test("services receive the actual bound DevHub origin when its port is overridden", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-frame-launch-"));
	let received = "";
	class FixtureProcesses extends Processes {
		override async adopt(): Promise<void> {
			await Promise.resolve();
		}
		override setFrameOrigin(origin: string): void {
			super.setFrameOrigin(origin);
			received = origin;
		}
	}
	const instance = await startHub({
		catalogue: catalogueSchema.parse({ port: 4712, projects: [] }),
		port: 0,
		root,
		runtime: {
			dockerView: async () => ({ available: false, projects: [] }),
			listeningPorts: async () => new Map(),
			listeningPortsV6: async () => new Map(),
			processes: new FixtureProcesses(root),
		},
	});
	try {
		expect(received).toBe(new URL(instance.url).origin);
		expect(received).not.toBe("http://127.0.0.1:4712");
	} finally {
		instance.stop();
		await rm(root, { force: true, recursive: true });
	}
});

test("the launcher refuses origins outside the canonical DevHub listener", () => {
	const processes = new Processes(".");
	for (const origin of [
		"https://127.0.0.1:4700",
		"http://evil.example:4700",
		"http://127.0.0.1:4700/",
		"http://user@127.0.0.1:4700",
		"http://127.0.0.1:4700?token=bad",
		"http://127.0.0.1:4700#bad",
		"http://127.0.0.1:0",
	]) {
		expect(() => processes.setFrameOrigin(origin)).toThrow();
	}
	expect(() => processes.setFrameOrigin("http://127.0.0.1:80")).not.toThrow();
	expect(() => processes.setFrameOrigin("http://127.0.0.1:4712")).not.toThrow();
});
