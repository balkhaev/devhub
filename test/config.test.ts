import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

import {
	type Catalogue,
	catalogueIssues,
	catalogueSchema,
	loadCatalogue,
	queueTokenFile,
	servicesOf,
	uiUrl,
} from "../src/config";

const catalogue = (projects: unknown[]): Catalogue =>
	catalogueSchema.parse({ code: "F:/code", projects });

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
	expect(studio?.project.path).toBe("F:/code/girls");
	expect(studio?.workdir).toBe(join("F:/code/girls", ""));
	expect(worker?.workdir).toBe(join("F:/code/girls", "apps/server"));
	expect(worker?.key).toBe("girls/worker");
});

test("pages are on the service's own port unless a full address is given", () => {
	const [service] = servicesOf(
		catalogue([
			{
				id: "mp",
				name: "MediaPipes",
				path: "F:/code/mediapipes",
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
				path: "F:/code/montage",
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

const queueProject = (services: unknown[], id = "inference") => ({
	id,
	name: id,
	path: `F:/fixture/${id}`,
	services,
});

test("a service starts by hand and has nothing to do with the queue unless its manifest says so", () => {
	const [plain, queue] = servicesOf(
		catalogue([
			queueProject([
				{ id: "plain", name: "Plain" },
				{
					autostart: true,
					id: "queue",
					name: "Queue",
					queue: { role: "queue", tokenFile: "runtime/api-token" },
				},
			]),
		])
	);
	expect(plain?.autostart).toBe(false);
	expect(plain?.queue).toBeUndefined();
	expect(queue?.autostart).toBe(true);
	expect(queue?.queue).toEqual({
		role: "queue",
		tokenFile: "runtime/api-token",
	});
	if (!(plain && queue)) {
		throw new Error("no services");
	}
	expect(queueTokenFile(plain)).toBeNull();
	expect(queueTokenFile(queue)).toBe(
		resolve("F:/fixture/inference", "runtime/api-token")
	);
	expect(() =>
		catalogue([
			queueProject([
				{
					id: "queue",
					name: "Queue",
					queue: { role: "panel", tokenFile: "t" },
				},
			]),
		])
	).toThrow();
	expect(() =>
		catalogue([
			queueProject([{ id: "queue", name: "Queue", queue: { role: "queue" } }]),
		])
	).toThrow();
});

test("one queue, one host of its executors, and a token inside the service's own project", () => {
	const declares = (id: string, role: string, tokenFile = "runtime/token") => ({
		id,
		name: id,
		queue: { role, tokenFile },
	});
	expect(
		catalogueIssues(
			catalogue([
				queueProject([
					declares("queue", "queue"),
					declares("executors", "executors"),
				]),
			])
		)
	).toEqual([]);
	expect(
		catalogueIssues(
			catalogue([
				queueProject([
					declares("queue", "queue"),
					declares("executors", "executors"),
					declares("second", "executors"),
				]),
				queueProject([declares("queue", "queue")], "other"),
			])
		)
	).toEqual([
		"роль общей очереди queue объявлена несколько раз: inference/queue, other/queue",
		"роль общей очереди executors объявлена несколько раз: inference/executors, inference/second",
	]);
	const outside = catalogue([
		queueProject([
			declares("queue", "queue", "../other/runtime/token"),
			declares("executors", "executors", "C:/Users/someone/token"),
		]),
	]);
	expect(catalogueIssues(outside)).toEqual([
		"inference/queue: файл токена очереди ../other/runtime/token выходит за папку проекта",
		"inference/executors: файл токена очереди C:/Users/someone/token выходит за папку проекта",
	]);
	expect(servicesOf(outside).map(queueTokenFile)).toEqual([null, null]);
});
