import { expect, test } from "bun:test";

import { parseNetstat, run } from "../src/probes";
import { alive } from "../src/processes";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       20464
  TCP    127.0.0.1:8088         0.0.0.0:0              LISTENING       47052
  TCP    127.0.0.1:8088         127.0.0.1:52011        ESTABLISHED     47052
  TCP    127.0.0.1:52011        127.0.0.1:8088         ESTABLISHED     10068
  TCP    [::]:3000              [::]:0                 LISTENING       20464
  TCP    [::1]:4747             [::]:0                 LISTENING       39736
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1488
`;

test("netstat gives each listening port the process that owns it", () => {
	const ports = parseNetstat(NETSTAT);
	expect(ports.get(3000)).toBe(20_464);
	expect(ports.get(8088)).toBe(47_052);
	expect(ports.get(4747)).toBe(39_736);
	expect(ports.get(135)).toBe(1488);
});

test("connections that do not listen are left out", () => {
	const ports = parseNetstat(NETSTAT);
	expect(ports.has(52_011)).toBe(false);
	expect([...ports.keys()].sort((a, b) => a - b)).toEqual([
		135, 3000, 4747, 8088,
	]);
});

test("netstat in another language is still read by its columns", () => {
	const russian = `
Активные подключения

  Имя    Локальный адрес        Внешний адрес          Состояние       PID
  TCP    127.0.0.1:8765         0.0.0.0:0              LISTENING       48924
`;
	expect(parseNetstat(russian).get(8765)).toBe(48_924);
});

test("a program out of time answers at once and takes its helpers with it", async () => {
	// The helper inherits the program's output and survives it, as docker's compose plugin does.
	const program = `
		const helper = require("node:child_process").spawn(
			process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" });
		console.log(helper.pid);
		setTimeout(() => {}, 60000);
	`;
	const started = Date.now();
	const result = await run(process.execPath, ["-e", program], 2000);
	const helper = Number(result.out.trim());
	try {
		expect(result.code).toBeNull();
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(helper).toBeGreaterThan(0);
		for (let waited = 0; waited < 5000 && alive(helper); waited += 100) {
			// biome-ignore lint/performance/noAwaitInLoops: polling until the helper is gone
			await Bun.sleep(100);
		}
		// Elsewhere only the program itself is ended, as before.
		expect(alive(helper)).toBe(process.platform !== "win32");
	} finally {
		if (helper > 0 && alive(helper)) {
			process.kill(helper);
		}
	}
});
