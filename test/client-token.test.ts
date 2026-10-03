import { expect, test } from "bun:test";
import { watch } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { clientToken } from "../src/client";

const TOKEN_FORMAT = /^[a-f0-9]{64}$/;
const FIXTURE_PREFIX = "devhub-client-token-test-";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
	const state = join(root, ".state");
	const file = join(state, "client-token");
	return {
		async close() {
			const absolute = resolve(root);
			if (
				dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
				!basename(absolute).startsWith(FIXTURE_PREFIX)
			) {
				throw new Error("Refuse cleanup outside client-token fixture");
			}
			await rm(absolute, { force: true, recursive: true });
		},
		file,
		root,
		state,
	};
}

test("creating and reloading a local client credential never rotates its value", async () => {
	const sample = await fixture();
	try {
		const created = await clientToken(sample.root);
		expect(created).toMatch(TOKEN_FORMAT);
		expect(await readFile(sample.file, "utf8")).toBe(created);
		const reloaded = await clientToken(sample.root);
		expect(reloaded).toBe(created);
		expect(await readFile(sample.file, "utf8")).toBe(created);
		expect(await readdir(sample.state)).toEqual(["client-token"]);
	} finally {
		await sample.close();
	}
});

test("simultaneous first callers all receive the same complete client credential", async () => {
	const sample = await fixture();
	await mkdir(sample.state);
	const observations: Promise<string>[] = [];
	const watcher = watch(sample.state, (_event, filename) => {
		if (filename?.toString() === "client-token") {
			observations.push(
				readFile(sample.file, "utf8").catch(() => "unreadable")
			);
		}
	});
	try {
		const results = await Promise.allSettled(
			Array.from({ length: 32 }, () => clientToken(sample.root))
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [String(result.reason)] : []
		);
		expect(failures).toEqual([]);
		const tokens = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : []
		);
		expect(tokens).toHaveLength(32);
		expect(tokens.every((token) => TOKEN_FORMAT.test(token))).toBe(true);
		expect(new Set(tokens).size).toBe(1);
		const [firstToken] = tokens;
		if (!firstToken) {
			throw new Error("No client credential was returned");
		}
		expect(await readFile(sample.file, "utf8")).toBe(firstToken);
		expect(await clientToken(sample.root)).toBe(firstToken);
		const observed = await Promise.all(observations);
		expect(observed.length).toBeGreaterThan(0);
		expect(observed.every((value) => TOKEN_FORMAT.test(value))).toBe(true);
		expect(await readdir(sample.state)).toEqual(["client-token"]);
	} finally {
		watcher.close();
		await sample.close();
	}
});

test.each(["", "invalid-client-credential", "a".repeat(63)])(
	"a corrupt existing local client credential is rejected and preserved: %j",
	async (corrupt) => {
		const sample = await fixture();
		try {
			await mkdir(sample.state);
			await writeFile(sample.file, corrupt);
			await expect(clientToken(sample.root)).rejects.toThrow("Повреждён");
			expect(await readFile(sample.file, "utf8")).toBe(corrupt);
			expect(await readdir(sample.state)).toEqual(["client-token"]);
		} finally {
			await sample.close();
		}
	}
);
