import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { packageEdits } from "../scripts/migrate-projects";

test("a declared synthetic dev entrypoint is preserved without inventing an original wrapper command", () => {
	const root = resolve("fixture-project");
	const scripts = {
		build: "own-production-build",
		dev: "node .devhub/launch.cjs dev",
	};
	const original = { packages: {}, version: 1 as const };
	const result = packageEdits(
		root,
		{
			id: "app",
			launch: { dev: ["api"] },
			name: "App",
			services: [{ command: "own-api-server", id: "api", name: "API" }],
		},
		[
			{
				data: { scripts },
				file: join(root, "package.json"),
				folder: "",
				scripts,
			},
		],
		original
	);
	expect(result.edits).toEqual([]);
	expect(original.packages).toEqual({});
});

test("a corrupted original wrapper or missing raw service is still rejected", () => {
	const root = resolve("fixture-project");
	const scripts = { dev: "node .devhub/launch.cjs dev" };
	const entry = {
		data: { scripts },
		file: join(root, "package.json"),
		folder: "",
		scripts,
	};
	const project = {
		id: "app",
		launch: { dev: ["api"] },
		name: "App",
		services: [{ command: "own-api-server", id: "api", name: "API" }],
	};
	expect(() =>
		packageEdits(root, project, [entry], {
			packages: { "package.json": scripts },
			version: 1,
		})
	).toThrow("cannot recover");
	expect(() =>
		packageEdits(root, { ...project, services: [] }, [entry], {
			packages: {},
			version: 1,
		})
	).toThrow("cannot recover");
});
