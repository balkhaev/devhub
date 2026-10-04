import { expect, test } from "bun:test";
import { join } from "node:path";

import {
	type Catalogue,
	catalogueIssues,
	catalogueSchema,
	loadCatalogue,
	servicesOf,
	uiUrl,
} from "../src/config";

const catalogue = (projects: unknown[]): Catalogue =>
	catalogueSchema.parse({ code: "D:/code", projects });

test("the hub's own services.json loads without duplicate service keys", async () => {
	const loaded = await loadCatalogue(
		join(import.meta.dir, "..", "services.json")
	);
	const keys = servicesOf(loaded).map((service) => service.key);
	expect(new Set(keys).size).toBe(keys.length);
});

test("paths use the code folder, and a service runs in its project's folder or one inside it", () => {
	const [studio, worker] = servicesOf(
		catalogue([
			{
				id: "girls",
				name: "Luv Club",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the catalogue's own placeholder for the code folder
				path: "${code}/girls",
				services: [
					{ id: "studio", name: "Studio" },
					{ cwd: "apps/server", id: "worker", name: "Worker" },
				],
			},
		])
	);
	expect(studio?.project.path).toBe("D:/code/girls");
	expect(studio?.workdir).toBe(join("D:/code/girls", ""));
	expect(worker?.workdir).toBe(join("D:/code/girls", "apps/server"));
	expect(worker?.key).toBe("girls/worker");
});

test("pages are on the service's own port unless a full address is given", () => {
	const [service] = servicesOf(
		catalogue([
			{
				id: "mp",
				name: "MediaPipes",
				path: "D:/code/mediapipes",
				services: [{ id: "api", name: "API", port: 8088 }],
			},
		])
	);
	if (!service) {
		throw new Error("no service");
	}
	expect(uiUrl(service, "/graph/")).toBe("http://127.0.0.1:8088/graph/");
	expect(uiUrl(service, "docs")).toBe("http://127.0.0.1:8088/docs");
	expect(uiUrl(service, "https://example.com/x")).toBe("https://example.com/x");
});

test("repeated services and needs that name nothing are found", () => {
	const issues = catalogueIssues(
		catalogue([
			{
				compose: { file: "docker-compose.yml", project: "montage" },
				id: "montage",
				name: "Montage",
				path: "D:/code/montage",
				services: [
					{ id: "server", name: "Server", needs: ["docker:montage"] },
					{ id: "server", name: "Server again" },
					{
						id: "web",
						name: "Web",
						needs: ["montage/server", "montage/nothing", "docker:nowhere"],
					},
				],
			},
		])
	);
	expect(issues).toEqual([
		"montage/server записан дважды",
		"montage/web ждёт montage/nothing, а такого в списке нет",
		"montage/web ждёт docker:nowhere, а такого в списке нет",
	]);
});
