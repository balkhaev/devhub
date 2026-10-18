import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogueSchema, type Service, servicesOf } from "../src/config";
import {
	approveLaunch,
	awaitReceipt,
	type LaunchIntent,
	type LaunchReceipt,
	launchFiles,
	matchesLauncher,
	readIntent,
	readReceipt,
	saveIntent,
} from "../src/desktop-launch";
import { type ProcessInfo, processInfo } from "../src/probes";
import {
	alive,
	batchOf,
	launchOutside,
	type Managed,
	Processes,
	shellLaunchScript,
} from "../src/processes";

const root = mkdtempSync(join(tmpdir(), "devhub-desktop-"));
const LINES = /\r?\n/;
afterAll(() => rmSync(root, { force: true, recursive: true }));
const windowsTest = process.platform === "win32" ? test : test.skip;
const desktopTest =
	process.platform === "win32" && process.env.DEVHUB_DESKTOP_LAUNCH_TEST === "1"
		? test
		: test.skip;

function fixture() {
	const folder = mkdtempSync(join(root, "case-"));
	const directory = join(folder, ".state", "launch");
	mkdirSync(directory, { recursive: true });
	const marker = randomUUID();
	const intent: LaunchIntent = {
		batch: join(folder, ".state", "run", `fixture-work-${marker}.cmd`),
		marker,
		requestedAt: Date.now(),
		state: "pending",
	};
	const files = launchFiles(directory, "fixture/work", marker);
	const receipt: LaunchReceipt = {
		...intent,
		command: `cmd.exe /c ""${intent.batch}" ${marker}"`,
		created: "639279045000000000",
		parent: 42,
		pid: process.pid,
	};
	const info: ProcessInfo = { ...receipt, name: "cmd.exe" };
	const service = servicesOf(
		catalogueSchema.parse({
			code: folder,
			projects: [
				{
					id: "fixture",
					name: "Neutral fixture",
					path: folder,
					services: [
						{ command: "cmd /d /c exit 0", id: "work", name: "Finite fixture" },
					],
				},
			],
		})
	)[0] as Service;
	return { directory, files, folder, info, intent, receipt, service };
}

test("desktop dispatch quotes its exact marker separately from the batch path", () => {
	expect(shellLaunchScript("D:\\a'b\\test.cmd", "marker")).toContain(
		".ShellExecute('D:\\a''b\\test.cmd', 'marker',"
	);
});

test("receipt requires the exact marker and batch; malformed and ambiguous receipts never authorize", async () => {
	const f = fixture();
	for (const invalid of [
		null,
		[f.receipt, f.receipt],
		{ ...f.receipt, marker: randomUUID() },
		{ ...f.receipt, command: `cmd /c other.cmd ${f.intent.marker}` },
		{ ...f.receipt, created: 123 },
	]) {
		writeFileSync(f.files.receipt, JSON.stringify(invalid));
		// biome-ignore lint/performance/noAwaitInLoops: each malformed receipt replaces the same fixture file
		expect(await readReceipt(f.files.receipt, f.intent)).toBeNull();
	}
	writeFileSync(f.files.receipt, JSON.stringify(f.receipt));
	expect(await readReceipt(f.files.receipt, f.intent)).toEqual(f.receipt);
	expect(matchesLauncher(f.info, f.receipt)).toBe(true);
	expect(
		matchesLauncher({ ...f.info, created: "639279045999999999" }, f.receipt)
	).toBe(false);
	expect(matchesLauncher({ ...f.info, created: undefined }, f.receipt)).toBe(
		false
	);
	expect(
		matchesLauncher(
			{ ...f.info, command: `${f.info.command}suffix` },
			{ ...f.receipt, marker: randomUUID() }
		)
	).toBe(false);
});

test("expired and missing receipts cancel durably, without permission for a late launcher", async () => {
	const f = fixture();
	await saveIntent(f.files.intent, f.intent);
	await expect(awaitReceipt(f.files, f.intent, 1)).rejects.toThrow(
		"not approved"
	);
	expect((await readIntent(f.files.intent))?.state).toBe("cancelled");
	expect(existsSync(f.files.approval)).toBe(false);
	writeFileSync(f.files.receipt, JSON.stringify(f.receipt));
	await expect(awaitReceipt(f.files, f.intent, 1)).rejects.toThrow(
		"not approved"
	);
});

test("damaged launch intent fails closed instead of being treated as a fresh launch", async () => {
	const f = fixture();
	writeFileSync(f.files.intent, "null");
	await expect(readIntent(f.files.intent)).rejects.toThrow();
});

test("cancellation between durable approval intent and permission never writes permission", async () => {
	const f = fixture();
	await expect(
		approveLaunch(f.files, f.intent, () => {
			throw new Error("cancelled");
		})
	).rejects.toThrow("cancelled");
	expect(existsSync(f.files.approval)).toBe(false);
});

function fakeRuntime(
	f: ReturnType<typeof fixture>,
	afterReceipt: () => Promise<void> = async () => undefined
) {
	let launches = 0;
	let latest = f.info;
	return {
		get launches() {
			return launches;
		},
		runtime: {
			dispatch: async (batch: string, marker = "") => {
				launches += 1;
				const receipt = {
					...f.receipt,
					batch,
					command: `cmd.exe /c ""${batch}" ${marker}"`,
					marker,
				};
				latest = { ...receipt, name: "cmd.exe" };
				const files = launchFiles(f.directory, f.service.key, marker);
				expect((await readIntent(files.intent))?.marker).toBe(marker);
				writeFileSync(files.receipt, JSON.stringify(receipt));
				await afterReceipt();
			},
			inspect: async () => new Map([[process.pid, latest]]),
			launchTimeoutMs: 500,
		},
	};
}

windowsTest(
	"an uncertain dispatch reconciles one receipt and persists ownership before permission",
	async () => {
		const f = fixture();
		const fake = fakeRuntime(f, () => {
			throw new Error("dispatch transport disappeared");
		});
		const processes = new Processes(
			f.folder,
			"",
			async () => undefined,
			fake.runtime
		);
		const entry = await processes.start(f.service);
		expect(fake.launches).toBe(1);
		const files = launchFiles(
			f.directory,
			f.service.key,
			entry.launcher?.marker ?? ""
		);
		expect(readFileSync(files.approval, "utf8")).toBe(
			entry.launcher?.marker ?? ""
		);
		const saved = JSON.parse(
			readFileSync(join(f.folder, ".state", "processes.json"), "utf8")
		);
		expect(saved[f.service.key]).toEqual(entry);
		await expect(processes.start(f.service)).rejects.toThrow("уже работает");
		expect(fake.launches).toBe(1);
	}
);

windowsTest(
	"pending discovery stop prevents approval and survives a later receipt",
	async () => {
		const f = fixture();
		let entered: () => void = () => undefined;
		let release: () => void = () => undefined;
		const received = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = fakeRuntime(f, async () => {
			entered();
			await blocked;
		});
		const processes = new Processes(
			f.folder,
			"",
			async () => undefined,
			fake.runtime
		);
		const starting = processes.start(f.service);
		await received;
		await processes.cancelPending(f.service.key);
		release();
		await expect(starting).rejects.toThrow();
		const intent = await readIntent(f.files.intent);
		expect(intent?.state).toBe("cancelled");
		expect(
			existsSync(
				launchFiles(f.directory, f.service.key, intent?.marker ?? "").approval
			)
		).toBe(false);
		expect(processes.get(f.service.key)).toBeUndefined();
	}
);

windowsTest(
	"a hub interrupted during discovery reconciles the same marker without redispatch",
	async () => {
		const f = fixture();
		await saveIntent(f.files.intent, f.intent);
		writeFileSync(f.files.receipt, JSON.stringify(f.receipt));
		const fake = fakeRuntime(f);
		const processes = new Processes(
			f.folder,
			"",
			async () => undefined,
			fake.runtime
		);
		const entry = await processes.start(f.service);
		expect(entry.launcher?.marker).toBe(f.intent.marker);
		expect(fake.launches).toBe(0);
	}
);

windowsTest(
	"live but unidentifiable approved intent blocks a second launch after lost state",
	async () => {
		const f = fixture();
		await saveIntent(f.files.intent, { ...f.intent, state: "approved" });
		const fake = fakeRuntime(f);
		const processes = new Processes(
			f.folder,
			"",
			async () => undefined,
			fake.runtime
		);
		await expect(processes.start(f.service)).rejects.toThrow(
			"no matching ownership"
		);
		expect(fake.launches).toBe(0);
	}
);

windowsTest(
	"new ownership is checked on adoption, stop and normal observation; missing metadata stays uncertain",
	async () => {
		const f = fixture();
		const entry: Managed = {
			command: "neutral",
			cwd: f.folder,
			exit: null,
			launcher: {
				batch: f.intent.batch,
				created: f.receipt.created,
				marker: f.intent.marker,
			},
			log: join(f.folder, "log"),
			pid: process.pid,
			startedAt: Date.now(),
			stopping: false,
		};
		const state = join(f.folder, ".state", "processes.json");
		writeFileSync(state, JSON.stringify({ [f.service.key]: entry }));
		let info = new Map<number, ProcessInfo>();
		const stopped: number[] = [];
		const processes = new Processes(
			f.folder,
			"",
			async (pid) => {
				stopped.push(pid);
				await Promise.resolve();
			},
			{ inspect: async () => info }
		);
		await processes.adopt();
		expect(processes.get(f.service.key)?.exit).toBeNull();
		await expect(processes.stop(f.service)).rejects.toThrow(
			"could not be verified"
		);
		expect(stopped).toEqual([]);
		info = new Map([
			[process.pid, { ...f.info, created: "639279045999999999" }],
		]);
		expect(processes.sweep(info)).toBe(true);
		expect(processes.get(f.service.key)?.exit).not.toBeNull();
		await processes.stop(f.service);
		writeFileSync(state, JSON.stringify({ [f.service.key]: entry }));
		const adopted = new Processes(f.folder, "", async () => undefined, {
			inspect: async () => info,
		});
		await adopted.adopt();
		expect(adopted.get(f.service.key)?.exit).not.toBeNull();
	}
);

async function eventually(
	predicate: () => boolean,
	timeoutMs = 10_000
): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > until) {
			throw new Error("finite neutral fixture did not complete");
		}
		// biome-ignore lint/performance/noAwaitInLoops: bounded polling of a finite neutral fixture
		await new Promise((done) => setTimeout(done, 50));
	}
}

for (const exitCode of [0, 7]) {
	desktopTest(
		`Explorer-owned neutral fixture preserves environment/cwd and immediate exit ${exitCode}`,
		async () => {
			const f = fixture();
			const output = join(f.folder, "result.txt");
			const command = join(f.folder, "fixture.cmd");
			writeFileSync(
				command,
				`@echo off\r\n> "${output}" echo %DEVHUB_FIXTURE_VALUE%\r\n>> "${output}" cd\r\nexit /b ${exitCode}\r\n`
			);
			f.service.command = `"${command}"`;
			f.service.env.DEVHUB_FIXTURE_VALUE = "neutral 100%";
			f.service.restart = exitCode === 0 ? "on-failure" : "never";
			const processes = new Processes(f.folder);
			const entry = await processes.start(f.service);
			const intent = await readIntent(f.files.intent);
			if (!intent) {
				throw new Error("missing intent");
			}
			const receipt = await readReceipt(
				launchFiles(f.directory, f.service.key, intent.marker).receipt,
				intent
			);
			if (!receipt) {
				throw new Error("missing receipt");
			}
			const parent = (await processInfo([receipt.parent])).get(receipt.parent);
			expect(parent?.name.toLowerCase()).toBe("explorer.exe");
			expect(BigInt(parent?.created ?? "0")).toBeLessThan(
				BigInt(receipt.created)
			);
			await eventually(() => !alive(entry.pid));
			processes.sweep();
			expect(entry.exit?.code).toBe(exitCode);
			expect(readFileSync(output, "utf8").trim().split(LINES)).toEqual([
				"neutral 100%",
				f.folder,
			]);
			const adopted = new Processes(f.folder);
			await adopted.adopt();
			expect(adopted.get(f.service.key)?.exit?.code).toBe(exitCode);
		},
		30_000
	);
}

windowsTest(
	"legacy PID reuse is refused before stop, and cancellation storage failure still stops a verified owner",
	async () => {
		const f = fixture();
		const entry: Managed = {
			command: "neutral",
			cwd: f.folder,
			exit: null,
			log: join(f.folder, "log"),
			pid: process.pid,
			startedAt: 1,
			stopping: false,
		};
		const failures = new Set<string>();
		let command = "unrelated.exe";
		const stopped: number[] = [];
		class Fixture extends Processes {
			override get() {
				return entry;
			}
			override async cancelPending() {
				await Promise.resolve();
				if (failures.has("cancel")) {
					throw new Error("cancellation storage failed");
				}
			}
		}
		const processes = new Fixture(
			f.folder,
			"",
			async (pid) => {
				stopped.push(pid);
				await Promise.resolve();
			},
			{ inspect: async () => new Map([[process.pid, { ...f.info, command }]]) }
		);
		await expect(processes.stop(f.service)).rejects.toThrow("identity changed");
		expect(stopped).toEqual([]);
		command = `cmd /c "${join(f.folder, ".state", "run", "fixture-work.cmd")}"`;
		failures.add("cancel");
		await expect(processes.stop(f.service)).rejects.toThrow(
			"cancellation storage failed"
		);
		expect(stopped).toEqual([process.pid]);
		expect(entry.stopping).toBe(true);
	}
);

windowsTest(
	"retired metadata is removed only after the old launcher is proven gone",
	async () => {
		const f = fixture();
		mkdirSync(join(f.folder, ".state", "run"), { recursive: true });
		writeFileSync(f.intent.batch, "old cancelled attempt");
		writeFileSync(
			f.files.receipt,
			JSON.stringify({ ...f.receipt, pid: 2_147_483_647 })
		);
		writeFileSync(f.files.approval, f.intent.marker);
		await saveIntent(f.files.intent, { ...f.intent, state: "cancelled" });
		const fake = fakeRuntime(f);
		const processes = new Processes(
			f.folder,
			"",
			async () => undefined,
			fake.runtime
		);
		const entry = await processes.start(f.service);
		expect(existsSync(f.intent.batch)).toBe(false);
		expect(existsSync(f.files.receipt)).toBe(false);
		expect(existsSync(f.files.approval)).toBe(false);
		expect(existsSync(entry.launcher?.batch ?? "")).toBe(true);
	}
);

windowsTest("unresolved live launch metadata survives cleanup", async () => {
	const f = fixture();
	mkdirSync(join(f.folder, ".state", "run"), { recursive: true });
	writeFileSync(f.intent.batch, "old unresolved launcher");
	writeFileSync(f.files.receipt, JSON.stringify(f.receipt));
	await saveIntent(f.files.intent, { ...f.intent, state: "cancelled" });
	const fake = fakeRuntime(f);
	const processes = new Processes(
		f.folder,
		"",
		async () => undefined,
		fake.runtime
	);
	await processes.start(f.service);
	expect(existsSync(f.intent.batch)).toBe(true);
	expect(existsSync(f.files.receipt)).toBe(true);
});

windowsTest(
	"malformed saved launcher identity neither breaks adoption nor downgrades to legacy stop",
	async () => {
		const f = fixture();
		const entry = {
			command: "neutral",
			cwd: f.folder,
			exit: null,
			launcher: { created: f.receipt.created, marker: f.intent.marker },
			log: join(f.folder, "log"),
			pid: process.pid,
			startedAt: 1,
			stopping: false,
		};
		writeFileSync(
			join(f.folder, ".state", "processes.json"),
			JSON.stringify({ [f.service.key]: entry })
		);
		const stopped: number[] = [];
		const processes = new Processes(
			f.folder,
			"",
			async (pid) => {
				stopped.push(pid);
				await Promise.resolve();
			},
			{ inspect: async () => new Map([[process.pid, f.info]]) }
		);
		await processes.adopt();
		expect(processes.get(f.service.key)?.exit).toBeNull();
		expect(processes.sweep(new Map([[process.pid, f.info]]))).toBe(false);
		await expect(processes.stop(f.service)).rejects.toThrow("identity changed");
		expect(stopped).toEqual([]);
		await expect(processes.start(f.service)).rejects.toThrow("уже работает");
	}
);

for (const state of ["pending", "approved"] as const) {
	desktopTest(
		`hub interruption after Managed save and ${state} intent never runs an unapproved command`,
		async () => {
			const f = fixture();
			const output = join(f.folder, "must-not-run.txt");
			f.service.command = `cmd /d /c echo unexpected > "${output}"`;
			const exitFile = join(
				f.folder,
				".state",
				"exit",
				`fixture-work-${f.intent.marker}.txt`
			);
			mkdirSync(join(f.folder, ".state", "run"), { recursive: true });
			mkdirSync(join(f.folder, ".state", "exit"), { recursive: true });
			writeFileSync(
				f.intent.batch,
				batchOf(f.service, join(f.folder, "log"), exitFile, f.folder, "", {
					files: f.files,
					intent: f.intent,
				})
			);
			await saveIntent(f.files.intent, f.intent);
			await launchOutside(f.intent.batch, f.intent.marker);
			const receipt = await awaitReceipt(f.files, f.intent);
			const entry: Managed = {
				command: f.service.command,
				cwd: f.folder,
				exit: null,
				launcher: {
					batch: f.intent.batch,
					created: receipt.created,
					marker: receipt.marker,
				},
				log: join(f.folder, "log"),
				pid: receipt.pid,
				startedAt: f.intent.requestedAt,
				stopping: false,
			};
			writeFileSync(
				join(f.folder, ".state", "processes.json"),
				JSON.stringify({ [f.service.key]: entry })
			);
			await saveIntent(f.files.intent, { ...f.intent, state });
			const processes = new Processes(f.folder);
			await processes.adopt();
			await eventually(() => !alive(receipt.pid));
			processes.sweep();
			expect(processes.get(f.service.key)?.exit?.code).toBe(125);
			expect(processes.get(f.service.key)?.stopping).toBe(false);
			expect(existsSync(output)).toBe(false);
			expect((await readIntent(f.files.intent))?.state).toBe("cancelled");
		},
		30_000
	);
}
