import { afterAll, beforeAll, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const windowsTest = test.skipIf(process.platform !== "win32");
const FIXTURE_PREFIX = "devhub-tray-test-";
let root = "";
let executable = "";

beforeAll(async () => {
	if (process.platform !== "win32") {
		return;
	}
	root = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
	executable = join(root, "TrayHarness.exe");
	const windows = process.env.WINDIR ?? "C:/Windows";
	const compilers = ["Framework64", "Framework"].map((framework) =>
		join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe")
	);
	const compiler = compilers.find((path) => existsSync(path));
	if (!compiler) {
		throw new Error(
			"Windows tray tests require the .NET Framework C# compiler"
		);
	}
	await run(
		compiler,
		[
			"/nologo",
			"/target:exe",
			"/codepage:65001",
			"/main:Devhub.TrayHarness",
			`/out:${executable}`,
			"/r:System.Windows.Forms.dll",
			"/r:System.Drawing.dll",
			"/r:System.Web.Extensions.dll",
			"/r:System.Core.dll",
			"/r:Microsoft.CSharp.dll",
			join(import.meta.dir, "..", "tray", "Tray.cs"),
			join(import.meta.dir, "tray-harness.cs"),
		],
		{ timeout: 20_000, windowsHide: true }
	);
});

afterAll(async () => {
	if (!root) {
		return;
	}
	const absolute = resolve(root);
	if (
		dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
		!basename(absolute).startsWith(FIXTURE_PREFIX)
	) {
		throw new Error(`Refuse cleanup outside tray fixture: ${absolute}`);
	}
	await rm(absolute, { force: true, recursive: true });
});

windowsTest(
	"the native tray parser keeps progress and rejects damaged answers",
	async () => {
		await run(executable, ["parser", root], {
			timeout: 10_000,
			windowsHide: true,
		});
	}
);

windowsTest(
	"stopping the hub leaves its launcher's running child alive",
	async () => {
		await run(executable, ["lifecycle", root, process.execPath], {
			timeout: 15_000,
			windowsHide: true,
		});
	}
);

windowsTest(
	"the hover popup follows live queue activity and paints its progress",
	async () => {
		await run(executable, ["popup", root], {
			timeout: 10_000,
			windowsHide: true,
		});
	}
);

windowsTest(
	"the hover popup shows the full waiting queue and scrolls to its final job",
	async () => {
		await run(executable, ["full-queue", root], {
			timeout: 10_000,
			windowsHide: true,
		});
	}
);

windowsTest(
	"the hover popup avoids notification flyouts on every monitor edge",
	async () => {
		await run(executable, ["placement", root], {
			timeout: 10_000,
			windowsHide: true,
		});
	}
);
