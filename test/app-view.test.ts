import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appViewOwner, appViewRefusal, probeOwner } from "../src/app-view";

const root = mkdtempSync(join(tmpdir(), "devhub-view-"));
const links: string[] = [];
afterAll(() => {
	// The links lead back to their own folders: they go first, as links.
	for (const link of links) {
		unlinkSync(link);
	}
	rmSync(root, { force: true, recursive: true });
});

/** A stand-in for `%LOCALAPPDATA%` with the private folders of the given packages in it. */
function localWith(name: string, packages: string[]): string {
	const local = join(root, name);
	for (const owner of packages) {
		mkdirSync(join(local, "Packages", owner, "LocalCache", "Local"), {
			recursive: true,
		});
	}
	mkdirSync(local, { recursive: true });
	return local;
}

test("a folder nobody redirects is the real one, and the probe is gone", () => {
	const local = localWith("real", ["Claude_test", "OpenAI.Codex_test"]);
	expect(appViewOwner(local)).toBeNull();
	expect(readdirSync(local)).toEqual(["Packages"]);
});

test("a probe that lands in a package's private folder names the package", () => {
	const local = localWith("redirected", ["Microsoft.Photos_test"]);
	// What the app's view does to this process: the file it creates in the folder is in the package's copy.
	const copy = join(local, "Packages", "Claude_test", "LocalCache");
	mkdirSync(copy, { recursive: true });
	symlinkSync(local, join(copy, "Local"), "junction");
	links.push(join(copy, "Local"));
	expect(appViewOwner(local)).toBe("Claude_test");
	expect(readdirSync(local)).toEqual(["Packages"]);
});

test("without the folder, or without packaged apps in it, there is no private view", () => {
	expect(appViewOwner("")).toBeNull();
	expect(appViewOwner(join(root, "absent"))).toBeNull();
	const bare = localWith("bare", []);
	expect(appViewOwner(bare)).toBeNull();
	expect(readdirSync(bare)).toEqual([]);
});

test("the probe is looked for by its own name only", () => {
	const local = localWith("named", ["Claude_test", "OpenAI.Codex_test"]);
	writeFileSync(
		join(local, "Packages", "OpenAI.Codex_test", "LocalCache", "Local", "mine"),
		""
	);
	expect(probeOwner(local, "mine")).toBe("OpenAI.Codex_test");
	expect(probeOwner(local, "another")).toBeNull();
});

test("the refusal names the app and the ways to start the hub outside it", () => {
	const words = appViewRefusal("Claude_test");
	expect(words).toContain("Claude_test");
	expect(words).toContain("Packages\\Claude_test\\LocalCache\\Local");
	expect(words).toContain("bun run open");
});
