import { expect, test } from "bun:test";

import { parseArguments, scriptTargets } from "../src/cli";
import { authenticatedClient } from "../src/client";
import { catalogueSchema } from "../src/config";

test("public project scripts resolve to deduplicated services", () => {
	const {
		projects: [project],
	} = catalogueSchema.parse({
		projects: [
			{
				id: "demo",
				launch: { dev: ["server", "web", "server", "infra/queue"] },
				name: "Demo",
				path: ".",
			},
		],
	});
	if (!project) {
		throw new Error("missing fixture");
	}
	expect(scriptTargets(project, "dev")).toEqual([
		"demo/server",
		"demo/web",
		"infra/queue",
	]);
	expect(() => scriptTargets(project, "nope")).toThrow("не зарегистрирована");
});

test("CLI requires complete project/script routing and refuses unregistered flags", () => {
	expect(
		parseArguments([
			"start",
			"--project",
			"D:/code/demo",
			"--script",
			"apps/web:dev",
		])
	).toEqual({
		action: "start",
		json: false,
		lines: 80,
		logs: false,
		project: "D:/code/demo",
		script: "apps/web:dev",
		targets: [],
		web: true,
	});
	expect(
		parseArguments(["prod", "altay", "--logs", "--lines", "20"])
	).toMatchObject({
		action: "prod",
		lines: 20,
		logs: true,
		targets: ["altay"],
	});
	expect(
		parseArguments(["create", "python", "notes", "--no-web"])
	).toMatchObject({ targets: ["python", "notes"], web: false });
	expect(() => parseArguments(["logs", "a/b", "--lines", "0"])).toThrow(
		"--lines"
	);
	expect(() => parseArguments(["start", "--project", "demo"])).toThrow(
		"вместе"
	);
	expect(() => parseArguments(["start", "demo/web", "--port", "4000"])).toThrow(
		"неизвестный параметр"
	);
	expect(() => parseArguments(["start", "--script"])).toThrow("нужно значение");
});

test("local CLI credential cannot authorize cross-origin browser requests", () => {
	const token = "a".repeat(64);
	const request = (headers: Record<string, string>) =>
		new Request("http://127.0.0.1:4700/api/projects/demo/start", {
			headers,
			method: "POST",
		});
	expect(
		authenticatedClient(request({ "x-devhub-client": token }), token)
	).toBe(true);
	expect(
		authenticatedClient(
			request({ origin: "https://example.com", "x-devhub-client": token }),
			token
		)
	).toBe(false);
	expect(
		authenticatedClient(request({ "x-devhub-client": "b".repeat(64) }), token)
	).toBe(false);
	expect(
		authenticatedClient(request({ "x-devhub-client": "é".repeat(64) }), token)
	).toBe(false);
});
