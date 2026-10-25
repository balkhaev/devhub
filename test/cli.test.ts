import { expect, test } from "bun:test";

import { parseArguments, reloadHub, scriptTargets } from "../src/cli";
import { authenticatedClient } from "../src/client";
import { catalogueSchema } from "../src/config";

test("CLI forwards custom creation folder as one argument", () => {
	expect(
		parseArguments([
			"create",
			"python",
			"my-app",
			"--base-dir",
			"D:/my projects",
			"--no-web",
		])
	).toMatchObject({
		baseDir: "D:/my projects",
		targets: ["python", "my-app"],
		web: false,
	});
});

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
			"F:/code/demo",
			"--script",
			"apps/web:dev",
		])
	).toEqual({
		action: "start",
		apply: false,
		idle: false,
		json: false,
		kill: false,
		lines: 80,
		logs: false,
		project: "F:/code/demo",
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
	expect(parseArguments(["tidy", "demo", "--apply"])).toMatchObject({
		action: "tidy",
		apply: true,
		targets: ["demo"],
	});
	expect(() => parseArguments(["stop", "demo", "--apply"])).toThrow(
		"только к tidy"
	);
	expect(parseArguments(["tidy", "--apply", "--kill"])).toMatchObject({
		apply: true,
		kill: true,
	});
	expect(parseArguments(["tidy", "--idle", "--json"])).toMatchObject({
		apply: false,
		idle: true,
	});
	expect(() => parseArguments(["tidy", "--apply", "--idle"])).toThrow(
		"не сочетается с --apply"
	);
	expect(() => parseArguments(["status", "--idle"])).toThrow("только к tidy");
	// Ending processes is never a side effect of a report.
	expect(() => parseArguments(["tidy", "demo", "--kill"])).toThrow(
		"только к tidy --apply"
	);
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

/** A clock that moves only when the reload waits, and a hub that answers from a script. */
function fakeHub(answers: (number | null)[]) {
	let time = 0;
	let signals = 0;
	const asked: number[] = [];
	return {
		asked,
		get signals() {
			return signals;
		},
		steps: {
			now: () => time,
			signal: () => {
				signals += 1;
			},
			started: () => {
				const answer = answers.length > 1 ? answers.shift() : answers[0];
				asked.push(time);
				return answer === null || answer === undefined
					? Promise.reject(new Error("hub is away"))
					: Promise.resolve(answer);
			},
			wait: (ms: number) => {
				time += ms;
				return Promise.resolve();
			},
		},
	};
}

test("reload signals the tray once and waits for a hub of a later run", async () => {
	const hub = fakeHub([100, 100, null, null, 250]);
	expect(await reloadHub(hub.steps)).toBe(250);
	expect(hub.signals).toBe(1);
	expect(hub.asked).toEqual([0, 500, 1000, 1500, 2000]);
});

test("reload gives up when no new hub answers in time", async () => {
	const hub = fakeHub([100]);
	await expect(reloadHub(hub.steps, 3000)).rejects.toThrow(
		"пульт не перезапустился за 3 с"
	);
	expect(hub.signals).toBe(1);
});

test("reload takes no targets or options", () => {
	expect(parseArguments(["reload"]).action).toBe("reload");
	for (const extra of [["agent"], ["--json"], ["--lines", "5"]]) {
		expect(() => parseArguments(["reload", ...extra])).toThrow(
			"reload перезапускает весь пульт"
		);
	}
});
