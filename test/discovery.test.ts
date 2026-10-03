import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalogueIssues, catalogueSchema, loadCatalogue } from "../src/config";

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { force: true, recursive: true }))
	);
});

test("repository dev contracts replace legacy entries and discover additional checkouts", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-discover-"));
	roots.push(root);
	const projects = join(root, "code");
	await Promise.all(
		["demo", "other"].map((name) =>
			mkdir(join(projects, name), { recursive: true })
		)
	);
	await Promise.all([
		writeFile(
			join(root, "services.json"),
			JSON.stringify({
				code: projects,
				discover: [projects],
				projects: [{ id: "demo", name: "Old", path: "old", services: [] }],
			})
		),
		writeFile(
			join(projects, "demo", "devhub.json"),
			JSON.stringify({
				id: "demo",
				launch: { dev: ["web"] },
				name: "Demo",
				services: [{ command: "vite", id: "web", name: "Web" }],
			})
		),
		writeFile(
			join(projects, "other", "devhub.json"),
			JSON.stringify({ id: "other", name: "Other", services: [] })
		),
	]);
	const catalogue = await loadCatalogue(join(root, "services.json"));
	expect(catalogue.projects.map((project) => project.name)).toEqual([
		"Demo",
		"Other",
	]);
	expect(catalogue.projects[0]?.path).toBe(join(projects, "demo"));
	await writeFile(
		join(projects, "other", "devhub.json"),
		JSON.stringify({ id: "demo", name: "Duplicate", services: [] })
	);
	expect(loadCatalogue(join(root, "services.json"))).rejects.toThrow(
		"проект demo записан дважды"
	);
});

test("dependency cycles and invalid entrypoint targets fail before any processes launch", () => {
	const catalogue = catalogueSchema.parse({
		projects: [
			{
				id: "demo",
				launch: { dev: ["missing"] },
				name: "Demo",
				path: ".",
				services: [
					{ id: "a", name: "A", needs: ["demo/b"] },
					{ id: "b", name: "B", needs: ["demo/a"] },
				],
			},
		],
	});
	const issues = catalogueIssues(catalogue);
	expect(issues.some((issue) => issue.includes("по кругу"))).toBe(true);
	expect(
		issues.some((issue) => issue.includes("неизвестный demo/missing"))
	).toBe(true);
});
