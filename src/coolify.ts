import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { z } from "zod";

import type { Catalogue } from "./config";

/**
 * Production as Coolify sees it, next to the same projects' dev servers: applications, databases and service stacks
 * of each project, their status, domains and commit, recent deployments and logs. Read-only: the hub never deploys,
 * restarts or changes anything in Coolify. The API token stays in this process; only chosen fields reach the page.
 */

export const coolifyConfigSchema = z.strictObject({
	/** Devhub project id → Coolify project names or application UUIDs, when the repository and name do not tell. */
	links: z.record(z.string(), z.array(z.string().min(1))).default({}),
	/** Environment variable with the API token (Coolify → Keys & Tokens, read access is enough). */
	tokenEnv: z
		.string()
		.regex(/^[A-Z_][A-Z0-9_]*$/)
		.default("COOLIFY_ACCESS_TOKEN"),
	/** The Coolify instance, e.g. https://deploy.example.com. */
	url: z.url(),
});
export type CoolifyConfig = z.infer<typeof coolifyConfigSchema>;

export interface ProdStatus {
	/** As Coolify words it: `running:healthy`, `exited:unhealthy`… */
	raw: string;
	state: "running" | "starting" | "stopped" | "degraded" | "unknown";
}

export interface ProdApplication {
	branch: string | null;
	buildPack: string | null;
	commit: string | null;
	/** Link to the application in the Coolify console. */
	console: string | null;
	domains: string[];
	environment: string | null;
	kind: "application";
	lastOnlineAt: string | null;
	name: string;
	project: string | null;
	repository: string | null;
	status: ProdStatus;
	updatedAt: string | null;
	uuid: string;
}

export interface ProdResource {
	console: string | null;
	environment: string | null;
	kind: "database" | "service";
	name: string;
	project: string | null;
	status: ProdStatus;
	type: string | null;
	uuid: string;
}

export interface ProdProject {
	applications: ProdApplication[];
	/** The Coolify projects these resources belong to. */
	coolifyProjects: string[];
	/** Devhub project id. */
	id: string;
	resources: ProdResource[];
}

export interface ProdView {
	configured: boolean;
	error: string | null;
	fetchedAt: number | null;
	projects: ProdProject[];
	/** Applications that no devhub project claims. */
	unmatched: ProdApplication[];
	url: string | null;
	version: string | null;
}

export interface ProdDeployment {
	commit: string | null;
	console: string | null;
	createdAt: string | null;
	finishedAt: string | null;
	message: string | null;
	status: string;
	trigger: "webhook" | "api" | "rollback" | "manual";
	uuid: string;
}

const REPOSITORY =
	/(?:github\.com|gitlab\.com|bitbucket\.org)[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const GIT_SUFFIX = /\.git$/;
const LINES = /\r?\n/;
const REGISTRY_STRING = /\s+REG_(?:EXPAND_)?SZ\s+/;
const TRAILING_SLASHES = /\/+$/;
const NOT_WORD = /[^a-z0-9]+/g;
const CACHE_MS = 30_000;
const TIMEOUT_MS = 20_000;
const MIN_PREFIX = 3;
const MAX_LOG_LINES = 2000;
/** The placeholder repository Coolify keeps for image and compose resources. */
const PLACEHOLDER_REPOSITORY = "coollabsio/coolify";

const rawApplication = z.looseObject({
	build_pack: z.string().nullish(),
	environment_id: z.number().nullish(),
	fqdn: z.string().nullish(),
	git_branch: z.string().nullish(),
	git_commit_sha: z.string().nullish(),
	git_repository: z.string().nullish(),
	last_online_at: z.string().nullish(),
	name: z.string(),
	status: z.string().nullish(),
	updated_at: z.string().nullish(),
	uuid: z.string(),
});
const rawResource = z.looseObject({
	database_type: z.string().nullish(),
	environment_id: z.number().nullish(),
	name: z.string(),
	status: z.string().nullish(),
	uuid: z.string(),
});
const rawProject = z.looseObject({
	environments: z
		.array(
			z.looseObject({
				id: z.number(),
				name: z.string(),
				uuid: z.string().nullish(),
			})
		)
		.default([]),
	name: z.string(),
	uuid: z.string(),
});
const rawDeployment = z.looseObject({
	commit: z.string().nullish(),
	commit_message: z.string().nullish(),
	created_at: z.string().nullish(),
	deployment_url: z.string().nullish(),
	deployment_uuid: z.string(),
	finished_at: z.string().nullish(),
	is_api: z.boolean().nullish(),
	is_webhook: z.boolean().nullish(),
	rollback: z.boolean().nullish(),
	status: z.string(),
});

const normal = (text: string): string =>
	text.toLowerCase().replace(NOT_WORD, "");

export function prodStatus(raw: string | null | undefined): ProdStatus {
	const text = (raw ?? "").toLowerCase();
	const [state = "", health = ""] = text.split(":");
	if (state.startsWith("running")) {
		return {
			raw: text,
			state: health === "unhealthy" ? "degraded" : "running",
		};
	}
	if (["starting", "restarting", "in_progress", "queued"].includes(state)) {
		return { raw: text, state: "starting" };
	}
	if (["exited", "stopped", "dead", "removing"].includes(state)) {
		return { raw: text, state: "stopped" };
	}
	if (state.includes("degraded")) {
		return { raw: text, state: "degraded" };
	}
	return { raw: text || "unknown", state: "unknown" };
}

/** `owner/repo` of a remote URL or of Coolify's `git_repository`. */
export function repositorySlug(
	remote: string | null | undefined
): string | null {
	const text = (remote ?? "").trim();
	if (!text) {
		return null;
	}
	const match = REPOSITORY.exec(text);
	const slug = match?.[1] ?? (SLUG.test(text) ? text : null);
	return slug ? slug.toLowerCase().replace(GIT_SUFFIX, "") : null;
}

/** The project's `origin`, read once per hub run. */
const remotes = new Map<string, string | null>();
export function projectRepository(path: string): string | null {
	if (!remotes.has(path)) {
		const result = spawnSync(
			"git",
			["-C", path, "remote", "get-url", "origin"],
			{
				encoding: "utf8",
				windowsHide: true,
			}
		);
		remotes.set(
			path,
			result.status === 0 ? repositorySlug(result.stdout) : null
		);
	}
	return remotes.get(path) ?? null;
}

/** The token from this process, or on Windows from the user's saved environment (set after the hub started). */
export function coolifyToken(name: string): string | null {
	const current = process.env[name];
	if (current) {
		return current;
	}
	if (process.platform !== "win32") {
		return null;
	}
	const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", name], {
		encoding: "utf8",
		windowsHide: true,
	});
	const line = result.stdout
		?.split(LINES)
		.find((entry) => entry.trim().startsWith(name));
	const value = line?.trim().split(REGISTRY_STRING)[1]?.trim();
	return value || null;
}

interface DevhubProject {
	id: string;
	name: string;
	path: string;
}

interface Inventory {
	applications: ProdApplication[];
	resources: ProdResource[];
	version: string | null;
}

/** The devhub project a Coolify project name belongs to: a link, one exact name, or one shared prefix. */
function nameOwner(
	name: string,
	projects: DevhubProject[],
	links: Record<string, string[]>
): string | undefined {
	const key = normal(name);
	const linked = Object.entries(links).find(([, targets]) =>
		targets.some((target) => normal(target) === key)
	)?.[0];
	if (linked) {
		return linked;
	}
	const exact = projects.filter((project) =>
		[project.id, project.name, basename(project.path)].some(
			(word) => normal(word) === key
		)
	);
	const prefix = projects.filter((project) =>
		[project.id, basename(project.path)].some((word) => {
			const own = normal(word);
			const [short, long] = own.length < key.length ? [own, key] : [key, own];
			return short.length >= MIN_PREFIX && long.startsWith(short);
		})
	);
	const found = exact.length === 1 ? exact : prefix;
	return found.length === 1 ? found[0]?.id : undefined;
}

/** Which devhub project each Coolify resource belongs to: explicit links, then repository, then project name. */
export function assignProduction(
	projects: DevhubProject[],
	inventory: Inventory,
	links: Record<string, string[]>,
	repository: (path: string) => string | null
): { projects: ProdProject[]; unmatched: ProdApplication[] } {
	const byRepository = new Map<string, string>();
	for (const project of projects) {
		const slug = repository(project.path);
		if (slug && !byRepository.has(slug)) {
			byRepository.set(slug, project.id);
		}
	}
	const coolifyNames = new Set(
		[...inventory.applications, ...inventory.resources].flatMap((entry) =>
			entry.project ? [entry.project] : []
		)
	);
	const byName = new Map<string, string>();
	for (const name of coolifyNames) {
		const id = nameOwner(name, projects, links);
		if (id) {
			byName.set(name, id);
		}
	}
	const linkedUuid = (uuid: string): string | undefined =>
		Object.entries(links).find(([, targets]) => targets.includes(uuid))?.[0];
	const owner = (entry: ProdApplication | ProdResource): string | undefined => {
		const linked = linkedUuid(entry.uuid);
		if (linked) {
			return linked;
		}
		if (entry.kind === "application" && entry.repository) {
			const slug = repositorySlug(entry.repository);
			const found =
				slug && slug !== PLACEHOLDER_REPOSITORY
					? byRepository.get(slug)
					: undefined;
			if (found) {
				return found;
			}
		}
		return entry.project ? byName.get(entry.project) : undefined;
	};
	const result = new Map<string, ProdProject>();
	const unmatched: ProdApplication[] = [];
	const known = new Set(projects.map((project) => project.id));
	const slot = (id: string): ProdProject => {
		let project = result.get(id);
		if (!project) {
			project = { applications: [], coolifyProjects: [], id, resources: [] };
			result.set(id, project);
		}
		return project;
	};
	for (const application of inventory.applications) {
		const id = owner(application);
		if (id && known.has(id)) {
			slot(id).applications.push(application);
		} else {
			unmatched.push(application);
		}
	}
	for (const resource of inventory.resources) {
		const id = owner(resource);
		if (id && known.has(id)) {
			slot(id).resources.push(resource);
		}
	}
	for (const project of result.values()) {
		project.coolifyProjects = [
			...new Set(
				[...project.applications, ...project.resources].flatMap((entry) =>
					entry.project ? [entry.project] : []
				)
			),
		].sort();
		project.applications.sort((a, b) => a.name.localeCompare(b.name));
		project.resources.sort((a, b) => a.name.localeCompare(b.name));
	}
	return {
		projects: [...result.values()].sort((a, b) => a.id.localeCompare(b.id)),
		unmatched: unmatched.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

export class CoolifyError extends Error {
	readonly status: number;
	constructor(
		message: string,
		options: ErrorOptions & { status?: number } = {}
	) {
		super(message, { cause: options.cause });
		this.status = options.status ?? 502;
	}
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class Coolify {
	private cached: { at: number; view: Promise<ProdView> } | null = null;
	private readonly fetcher: Fetch;
	private readonly token: () => string | null;
	/** The hub's current catalogue: projects come and go while it runs. */
	private readonly catalogue: () => Catalogue;

	constructor(
		catalogue: () => Catalogue,
		options: { fetch?: Fetch; token?: () => string | null } = {}
	) {
		this.catalogue = catalogue;
		this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
		this.token =
			options.token ??
			(() => coolifyToken(this.config?.tokenEnv ?? "COOLIFY_ACCESS_TOKEN"));
	}

	get config(): CoolifyConfig | null {
		return this.catalogue().coolify ?? null;
	}

	private base(): string {
		if (!this.config) {
			throw new CoolifyError(
				"Coolify не настроен: добавьте coolify.url в services.json",
				{ status: 404 }
			);
		}
		return this.config.url.replace(TRAILING_SLASHES, "");
	}

	private async get(path: string): Promise<unknown> {
		const token = this.token();
		if (!token) {
			throw new CoolifyError(
				`Нет токена Coolify: задайте переменную ${this.config?.tokenEnv ?? "COOLIFY_ACCESS_TOKEN"}`,
				{ status: 401 }
			);
		}
		let response: Response;
		try {
			response = await this.fetcher(`${this.base()}/api/v1${path}`, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (error) {
			throw new CoolifyError(
				`Coolify не отвечает: ${(error as Error).message}`,
				{ cause: error, status: 502 }
			);
		}
		if (response.status === 401 || response.status === 403) {
			throw new CoolifyError(
				"Coolify отклонил токен: проверьте его права (read)",
				{ status: 401 }
			);
		}
		if (!response.ok) {
			throw new CoolifyError(`Coolify ${path}: HTTP ${response.status}`);
		}
		// `/version` answers with plain text; everything else is JSON.
		const text = await response.text();
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text.trim();
		}
	}

	private consoleLink(path: string | null): string | null {
		return path && this.config ? `${this.base()}${path}` : null;
	}

	private async inventory(): Promise<Inventory> {
		const [version, applications, databases, services, projects] =
			await Promise.all([
				this.get("/version").catch(() => null),
				this.get("/applications"),
				this.get("/databases").catch(() => []),
				this.get("/services").catch(() => []),
				this.get("/projects"),
			]);
		const projectList = z.array(rawProject).parse(projects);
		const detailed = await Promise.all(
			projectList.map((project) =>
				this.get(`/projects/${encodeURIComponent(project.uuid)}`)
					.then((detail) => rawProject.parse(detail))
					.catch(() => project)
			)
		);
		const environments = new Map<
			number,
			{ environment: string; path: string | null; project: string }
		>();
		for (const project of detailed) {
			for (const environment of project.environments) {
				environments.set(environment.id, {
					environment: environment.name,
					path: environment.uuid
						? `/project/${project.uuid}/environment/${environment.uuid}`
						: `/project/${project.uuid}`,
					project: project.name,
				});
			}
		}
		const place = (id: number | null | undefined) =>
			id === null || id === undefined ? undefined : environments.get(id);
		const apps = z
			.array(rawApplication)
			.parse(applications)
			.map((app): ProdApplication => {
				const where = place(app.environment_id);
				return {
					branch: app.git_branch ?? null,
					buildPack: app.build_pack ?? null,
					commit:
						app.git_commit_sha && app.git_commit_sha !== "HEAD"
							? app.git_commit_sha
							: null,
					console: this.consoleLink(
						where?.path ? `${where.path}/application/${app.uuid}` : null
					),
					domains: (app.fqdn ?? "")
						.split(",")
						.map((domain) => domain.trim())
						.filter(Boolean),
					environment: where?.environment ?? null,
					kind: "application",
					lastOnlineAt: app.last_online_at ?? null,
					name: app.name,
					project: where?.project ?? null,
					repository:
						app.build_pack === "dockerimage" ||
						repositorySlug(app.git_repository) === PLACEHOLDER_REPOSITORY
							? null
							: (app.git_repository ?? null),
					status: prodStatus(app.status),
					updatedAt: app.updated_at ?? null,
					uuid: app.uuid,
				};
			});
		const resource = (
			kind: ProdResource["kind"],
			entries: unknown
		): ProdResource[] =>
			(Array.isArray(entries) ? entries : []).flatMap((entry) => {
				const parsed = rawResource.safeParse(entry);
				if (!parsed.success) {
					return [];
				}
				const where = place(parsed.data.environment_id);
				return [
					{
						console: this.consoleLink(
							where?.path ? `${where.path}/${kind}/${parsed.data.uuid}` : null
						),
						environment: where?.environment ?? null,
						kind,
						name: parsed.data.name,
						project: where?.project ?? null,
						status: prodStatus(parsed.data.status),
						type: parsed.data.database_type ?? null,
						uuid: parsed.data.uuid,
					},
				];
			});
		return {
			applications: apps,
			resources: [
				...resource("database", databases),
				...resource("service", services),
			],
			version: typeof version === "string" ? version : null,
		};
	}

	private async load(): Promise<ProdView> {
		const fetchedAt = Date.now();
		const inventory = await this.inventory();
		const catalogue = this.catalogue();
		const projects = catalogue.projects.map((project) => ({
			id: project.id,
			name: project.name,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: machine catalogue placeholder
			path: project.path.replaceAll("${code}", catalogue.code),
		}));
		const assigned = assignProduction(
			projects,
			inventory,
			this.config?.links ?? {},
			projectRepository
		);
		return {
			configured: true,
			error: null,
			fetchedAt,
			projects: assigned.projects,
			unmatched: assigned.unmatched,
			url: this.base(),
			version: inventory.version,
		};
	}

	/** Everything Coolify runs, by devhub project; kept for a short while so the page can ask freely. */
	async view(refresh = false): Promise<ProdView> {
		if (!this.config) {
			return {
				configured: false,
				error: null,
				fetchedAt: null,
				projects: [],
				unmatched: [],
				url: null,
				version: null,
			};
		}
		if (refresh || !this.cached || Date.now() - this.cached.at > CACHE_MS) {
			const view = this.load();
			this.cached = { at: Date.now(), view };
			view.catch(() => {
				if (this.cached?.view === view) {
					this.cached = null;
				}
			});
		}
		try {
			return await this.cached.view;
		} catch (error) {
			return {
				configured: true,
				error: (error as Error).message,
				fetchedAt: Date.now(),
				projects: [],
				unmatched: [],
				url: this.config.url,
				version: null,
			};
		}
	}

	/** An application this hub showed; anything else is refused before Coolify is asked. */
	private async known(uuid: string): Promise<ProdApplication> {
		const view = await this.view();
		const application = [
			...view.projects.flatMap((project) => project.applications),
			...view.unmatched,
		].find((entry) => entry.uuid === uuid);
		if (!application) {
			throw new CoolifyError(`нет приложения ${uuid}`, { status: 404 });
		}
		return application;
	}

	async deployments(uuid: string, take = 5): Promise<ProdDeployment[]> {
		await this.known(uuid);
		const body = await this.get(
			`/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=${Math.max(1, Math.min(take, 20))}`
		);
		const list = z
			.union([
				z.looseObject({ deployments: z.array(z.unknown()) }),
				z.array(z.unknown()),
			])
			.parse(body);
		const entries = Array.isArray(list) ? list : list.deployments;
		return entries.flatMap((entry) => {
			const parsed = rawDeployment.safeParse(entry);
			if (!parsed.success) {
				return [];
			}
			const deployment = parsed.data;
			let trigger: ProdDeployment["trigger"] = "manual";
			if (deployment.rollback) {
				trigger = "rollback";
			} else if (deployment.is_webhook) {
				trigger = "webhook";
			} else if (deployment.is_api) {
				trigger = "api";
			}
			return [
				{
					commit:
						deployment.commit && deployment.commit !== "HEAD"
							? deployment.commit
							: null,
					console: this.consoleLink(deployment.deployment_url ?? null),
					createdAt: deployment.created_at ?? null,
					finishedAt: deployment.finished_at ?? null,
					message: deployment.commit_message?.split("\n")[0] ?? null,
					status: deployment.status,
					trigger,
					uuid: deployment.deployment_uuid,
				},
			];
		});
	}

	async logs(uuid: string, lines = 200): Promise<string> {
		await this.known(uuid);
		const count = Math.max(
			1,
			Math.min(Math.trunc(lines) || 200, MAX_LOG_LINES)
		);
		const body = await this.get(
			`/applications/${encodeURIComponent(uuid)}/logs?lines=${count}`
		);
		const parsed = z
			.looseObject({ logs: z.string().nullish() })
			.safeParse(body);
		return parsed.success ? (parsed.data.logs ?? "") : "";
	}
}
