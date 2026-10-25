import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { isGeneratedNextEnv } from "../src/generated-next-env";

const fixtures: string[] = [];
const generated = (routes = ".next/types/routes.d.ts") =>
	[
		'/// <reference types="next" />',
		'/// <reference types="next/image-types/global" />',
		`import "./${routes}";`,
		"",
		"// NOTE: This file should not be edited",
		"// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
		"",
	].join("\n");

function fixture(manifest = '{"dependencies":{"next":"16.0.0"}}') {
	const root = mkdtempSync(join(tmpdir(), "devhub-next-env-test-"));
	fixtures.push(root);
	const folder = join(root, "apps", "web");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "package.json"), manifest);
	const entry = join("apps", "web", "next-env.d.ts");
	writeFileSync(join(root, entry), generated());
	return { entry, folder, root };
}

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-next-env-test-")
		) {
			throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

describe("known generated Next environment declarations", () => {
	for (const routes of [
		".next/types/routes.d.ts",
		".next/dev/types/routes.d.ts",
	]) {
		for (const newline of ["\n", "\r\n"]) {
			test(`accepts ${routes} with ${JSON.stringify(newline)}`, () => {
				const { root, entry } = fixture();
				writeFileSync(
					join(root, entry),
					generated(routes).split("\n").join(newline)
				);
				expect(isGeneratedNextEnv(root, entry)).toBe(true);
			});
		}
	}

	test("accepts a Next devDependency and a package at the checkout root", () => {
		const { root } = fixture();
		writeFileSync(
			join(root, "package.json"),
			'{"devDependencies":{"next":"^16"}}'
		);
		writeFileSync(join(root, "next-env.d.ts"), generated());
		expect(isGeneratedNextEnv(root, "next-env.d.ts")).toBe(true);
	});

	for (const manifest of [
		"{}",
		"null",
		"invalid json",
		'{"dependencies":{"next":""}}',
		'{"dependencies":{"next":true}}',
	]) {
		test(`rejects a missing or invalid Next dependency: ${manifest}`, () => {
			const { root, entry } = fixture(manifest);
			expect(isGeneratedNextEnv(root, entry)).toBe(false);
		});
	}

	for (const content of [
		`${generated()}// private local notes\n`,
		`${generated()}import "./private.d.ts";\n`,
		generated(".next/private/routes.d.ts"),
		generated().replace('types="next"', 'types="custom"'),
		"x".repeat(4096),
	]) {
		test(`rejects unknown or additional content: ${content.slice(0, 35)} (${content.length})`, () => {
			const { root, entry } = fixture();
			writeFileSync(join(root, entry), content);
			expect(isGeneratedNextEnv(root, entry)).toBe(false);
		});
	}

	test("requires the manifest beside the declaration and refuses other filenames", () => {
		const { root, folder, entry } = fixture();
		writeFileSync(join(folder, "custom.d.ts"), generated());
		expect(isGeneratedNextEnv(root, join("apps", "web", "custom.d.ts"))).toBe(
			false
		);
		rmSync(join(folder, "package.json"));
		writeFileSync(join(root, "package.json"), '{"dependencies":{"next":"16"}}');
		expect(isGeneratedNextEnv(root, entry)).toBe(false);
		expect(isGeneratedNextEnv(root, join("missing", "next-env.d.ts"))).toBe(
			false
		);
	});

	test("refuses a linked package directory and paths outside the checkout", () => {
		const { root, folder } = fixture();
		const linked = join(root, "linked");
		symlinkSync(
			folder,
			linked,
			process.platform === "win32" ? "junction" : "dir"
		);
		expect(isGeneratedNextEnv(root, join("linked", "next-env.d.ts"))).toBe(
			false
		);
		expect(
			isGeneratedNextEnv(join(root, "apps"), join(root, "next-env.d.ts"))
		).toBe(false);
	});

	test("refuses a symlinked declaration or package manifest", () => {
		const { root, folder, entry } = fixture();
		const original = join(root, "declaration.txt");
		writeFileSync(original, generated());
		rmSync(join(root, entry));
		symlinkSync(original, join(root, entry), "file");
		expect(isGeneratedNextEnv(root, entry)).toBe(false);
		rmSync(join(root, entry));
		writeFileSync(join(root, entry), generated());
		const manifest = join(root, "manifest.json");
		writeFileSync(manifest, '{"dependencies":{"next":"16"}}');
		rmSync(join(folder, "package.json"));
		symlinkSync(manifest, join(folder, "package.json"), "file");
		expect(isGeneratedNextEnv(root, entry)).toBe(false);
	});
});
