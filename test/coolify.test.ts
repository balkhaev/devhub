import { expect, test } from "bun:test";

import type { Catalogue } from "../src/config";
import {
	assignProduction,
	Coolify,
	type ProdApplication,
	type ProdResource,
	prodStatus,
	repositorySlug,
} from "../src/coolify";

const TOKEN = "secret-token";

function application(
	name: string,
	project: string | null,
	repository: string | null = null
): ProdApplication {
	return {
		branch: "main",
		buildPack: "dockerfile",
		commit: null,
		console: null,
		domains: [],
		environment: "production",
		kind: "application",
		lastOnlineAt: null,
		name,
		project,
		repository,
		status: prodStatus("running:healthy"),
		updatedAt: null,
		uuid: `uuid-${name}`,
	};
}

function database(name: string, project: string): ProdResource {
	return {
		console: null,
		environment: "production",
		kind: "database",
		name,
		project,
		status: prodStatus("running:healthy"),
		type: "standalone-postgresql",
		uuid: `uuid-${name}`,
	};
}

test("statuses and repositories read the way Coolify and Git write them", () => {
	expect(prodStatus("running:healthy").state).toBe("running");
	expect(prodStatus("running:unhealthy").state).toBe("degraded");
	expect(prodStatus("exited:unhealthy").state).toBe("stopped");
	expect(prodStatus("restarting").state).toBe("starting");
	expect(prodStatus(null)).toEqual({ raw: "unknown", state: "unknown" });
	expect(repositorySlug("https://github.com/balkhaev/altay.git")).toBe(
		"balkhaev/altay"
	);
	expect(repositorySlug("git@github.com:Balkhaev/Inference.git")).toBe(
		"balkhaev/inference"
	);
	expect(repositorySlug("balkhaev/girls")).toBe("balkhaev/girls");
	expect(repositorySlug("")).toBeNull();
});

test("resources go to projects by link, then repository, then Coolify project name", () => {
	const projects = [
		{ id: "altay", name: "Алтай", path: "D:/code/altay" },
		{ id: "luvclub", name: "Luv Club", path: "D:/code/girls" },
		{ id: "soclogin", name: "Soclogin", path: "D:/code/soclogin" },
		{ id: "zemstroy", name: "Земстрой CRM", path: "D:/code/zemstroy-crm" },
		{ id: "montage", name: "Montage", path: "D:/code/montage" },
		{ id: "balkhaev-com", name: "balkhaev.com", path: "D:/code/balkhaev.com" },
	];
	const repositories: Record<string, string> = {
		"D:/code/girls": "balkhaev/girls",
		"D:/code/soclogin": "balkhaev/soclogin",
		"D:/code/zemstroy-crm": "balkhaev/zemcrm",
	};
	const result = assignProduction(
		projects,
		{
			applications: [
				application("altay", "altay", "balkhaev/altay"),
				application("web", "luv", "balkhaev/girls"),
				application("cloak-browser", "base", "balkhaev/soclogin"),
				application("omniroute", "base"),
				application("zemstroy-crm-web-git", "zemstroy", "balkhaev/zemcrm"),
				application("montage-web", "montage"),
				application("site", "balkhaev.com"),
				application("film", "films"),
			],
			resources: [
				database("luv-redis", "luv"),
				database("montage-db", "montage"),
			],
			version: null,
		},
		{ montage: ["uuid-film"] },
		(path) => repositories[path] ?? null
	);
	const owned = Object.fromEntries(
		result.projects.map((project) => [
			project.id,
			[
				...project.applications.map((app) => app.name),
				...project.resources.map((resource) => resource.name),
			],
		])
	);
	expect(owned).toEqual({
		altay: ["altay"],
		"balkhaev-com": ["site"],
		luvclub: ["web", "luv-redis"],
		montage: ["film", "montage-web", "montage-db"],
		soclogin: ["cloak-browser"],
		zemstroy: ["zemstroy-crm-web-git"],
	});
	expect(result.unmatched.map((app) => app.name)).toEqual(["omniroute"]);
	expect(
		result.projects.find((project) => project.id === "soclogin")
			?.coolifyProjects
	).toEqual(["base"]);
});

function fakeCoolify(requests: string[]) {
	const answers: Record<string, unknown> = {
		"/applications": [
			{
				build_pack: "dockerfile",
				environment_id: 13,
				fqdn: "https://altay.example.com,https://www.altay.example.com",
				git_branch: "main",
				git_commit_sha: "abc1234def",
				git_repository: "balkhaev/altay",
				http_basic_auth_password: "never-shown",
				manual_webhook_secret_github: "never-shown",
				name: "altay",
				status: "running:healthy",
				uuid: "app-1",
			},
		],
		"/applications/app-1/logs?lines=5": { logs: "line 1\nline 2" },
		"/databases": [],
		"/deployments/applications/app-1?skip=0&take=5": {
			count: 1,
			deployments: [
				{
					commit: "abc1234def",
					commit_message: "Ship it\n\nbody",
					created_at: "2026-10-04T00:55:39.000000Z",
					deployment_url:
						"/project/p1/environment/e1/application/app-1/deployment/d1",
					deployment_uuid: "d1",
					is_webhook: true,
					logs: '[{"output":"SECRET=1"}]',
					status: "finished",
				},
			],
		},
		"/projects": [{ name: "altay", uuid: "p1" }],
		"/projects/p1": {
			environments: [{ id: 13, name: "production", uuid: "e1" }],
			name: "altay",
			uuid: "p1",
		},
		"/services": [],
		"/version": "4.3.23",
	};
	return (input: string, init?: RequestInit) => {
		const url = new URL(input);
		const path = `${url.pathname.replace("/api/v1", "")}${url.search}`;
		requests.push(path);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			`Bearer ${TOKEN}`
		);
		const body = answers[path];
		if (body === undefined) {
			return Promise.resolve(new Response("missing", { status: 404 }));
		}
		return Promise.resolve(
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status: 200,
			})
		);
	};
}

const catalogue = (coolify?: Catalogue["coolify"]): Catalogue => ({
	aliases: {},
	code: "D:/code",
	coolify,
	discover: [],
	exclude: [],
	port: 4700,
	projects: [
		{
			id: "altay",
			launch: {},
			name: "Алтай",
			path: "D:/nowhere/altay",
			services: [],
		},
	],
});

test("the hub reads Coolify with its token and passes only chosen fields on", async () => {
	const requests: string[] = [];
	const coolify = new Coolify(
		() =>
			catalogue({
				links: {},
				tokenEnv: "COOLIFY_ACCESS_TOKEN",
				url: "https://deploy.example.com/",
			}),
		{ fetch: fakeCoolify(requests), token: () => TOKEN }
	);
	const view = await coolify.view();
	expect(view.error).toBeNull();
	expect(view.version).toBe("4.3.23");
	expect(view.url).toBe("https://deploy.example.com");
	const [project] = view.projects;
	expect(project?.id).toBe("altay");
	const app = project?.applications[0];
	expect(app?.domains).toEqual([
		"https://altay.example.com",
		"https://www.altay.example.com",
	]);
	expect(app?.console).toBe(
		"https://deploy.example.com/project/p1/environment/e1/application/app-1"
	);
	expect(JSON.stringify(view)).not.toContain("never-shown");
	const deployments = await coolify.deployments("app-1");
	expect(deployments).toEqual([
		{
			commit: "abc1234def",
			console:
				"https://deploy.example.com/project/p1/environment/e1/application/app-1/deployment/d1",
			createdAt: "2026-10-04T00:55:39.000000Z",
			finishedAt: null,
			message: "Ship it",
			status: "finished",
			trigger: "webhook",
			uuid: "d1",
		},
	]);
	expect(JSON.stringify(deployments)).not.toContain("SECRET");
	expect(await coolify.logs("app-1", 5)).toBe("line 1\nline 2");
	// Cached: a second look does not ask Coolify again; an unknown application is refused locally.
	const before = requests.length;
	await coolify.view();
	expect(requests.length).toBe(before);
	await expect(coolify.logs("someone-else")).rejects.toThrow("нет приложения");
	expect(requests.length).toBe(before);
});

test("without configuration or token the hub says what is missing", async () => {
	const unconfigured = new Coolify(() => catalogue(), {
		fetch: () => Promise.reject(new Error("must not be called")),
		token: () => TOKEN,
	});
	expect(await unconfigured.view()).toMatchObject({
		configured: false,
		projects: [],
	});
	const tokenless = new Coolify(
		() =>
			catalogue({
				links: {},
				tokenEnv: "COOLIFY_ACCESS_TOKEN",
				url: "https://deploy.example.com",
			}),
		{
			fetch: () => Promise.reject(new Error("must not be called")),
			token: () => null,
		}
	);
	const view = await tokenless.view();
	expect(view.configured).toBe(true);
	expect(view.error).toContain("COOLIFY_ACCESS_TOKEN");
});
