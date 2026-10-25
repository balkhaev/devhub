import { describe, expect, test } from "bun:test";

import { NEXT_DEV_HEAP_MB, nextDevNodeOptions } from "../src/next-dev-memory";

const limit = `--max-old-space-size=${NEXT_DEV_HEAP_MB}`;

describe("nextDevNodeOptions", () => {
	test("caps the heap of every way a project starts next dev", () => {
		for (const command of [
			"next dev --port 3301",
			"next dev",
			"bun next dev --hostname 127.0.0.1 --port 8083",
			"node node_modules/next/dist/bin/next dev",
			'"node_modules\\.bin\\next.cmd" dev --port 3001',
		]) {
			expect(nextDevNodeOptions(command, undefined)).toBe(limit);
		}
	});

	test("keeps other NODE_OPTIONS and adds the limit after them", () => {
		expect(nextDevNodeOptions("next dev", " --enable-source-maps ")).toBe(
			`--enable-source-maps ${limit}`
		);
	});

	test("respects a limit the service or the hub already sets", () => {
		expect(
			nextDevNodeOptions("next dev", "--max-old-space-size=8192")
		).toBeUndefined();
		expect(
			nextDevNodeOptions("next dev", "--max_old_space_size=2048")
		).toBeUndefined();
	});

	test("leaves other servers alone", () => {
		for (const command of [
			undefined,
			"next build",
			"next start --port 3000",
			"bun run --hot src/index.ts",
			"bun x --no-install vite --port 3022",
			"turbo run dev --filter=@adorely/web-neon",
			"uv run uvicorn app:app --reload",
			"nextdev",
		]) {
			expect(nextDevNodeOptions(command, undefined)).toBeUndefined();
		}
	});
});
