import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
	protectPrivateDirectory,
	protectPrivateFile,
} from "../src/private-files";

const windowsTest = process.platform === "win32" ? test : test.skip;
const runFile = promisify(execFile);

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "devhub-private-files-test-"));
	return {
		cleanup: async () => {
			const absolute = resolve(root);
			if (
				dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
				!basename(absolute).startsWith("devhub-private-files-test-")
			) {
				throw new Error("Refuse cleanup outside the private-file fixture");
			}
			await rm(absolute, { force: true, recursive: true });
		},
		root,
	};
}

function grant(target: string, rights: string) {
	return runFile(
		join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
		[target, "/grant", rights, "/Q"],
		{ timeout: 10_000, windowsHide: true }
	);
}

windowsTest(
	"unexpected explicit file access fails closed and preserves existing bytes",
	async () => {
		const files = await fixture();
		try {
			const file = join(files.root, "client-token");
			await writeFile(file, "existing-fixture-bytes");
			await grant(file, "*S-1-5-11:R");
			await expect(protectPrivateFile(file)).rejects.toMatchObject({
				status: 500,
			});
			expect(await readFile(file, "utf8")).toBe("existing-fixture-bytes");
		} finally {
			await files.cleanup();
		}
	}
);

windowsTest(
	"unexpected explicit directory access fails closed before resetting child files",
	async () => {
		const files = await fixture();
		try {
			const file = join(files.root, "vault.key");
			await writeFile(file, "existing-fixture-bytes");
			await grant(files.root, "*S-1-5-11:(OI)(CI)R");
			await expect(protectPrivateDirectory(files.root)).rejects.toMatchObject({
				status: 500,
			});
			expect(await readFile(file, "utf8")).toBe("existing-fixture-bytes");
		} finally {
			await files.cleanup();
		}
	}
);

windowsTest(
	"ACL verification accepts a private file and treats its filename as a parameter",
	async () => {
		const files = await fixture();
		try {
			const file = join(files.root, "private token ' $value &.txt");
			await writeFile(file, "existing-fixture-bytes");
			await protectPrivateFile(file);
			expect(await readFile(file, "utf8")).toBe("existing-fixture-bytes");
		} finally {
			await files.cleanup();
		}
	}
);
