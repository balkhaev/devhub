import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import {
	developmentSourceIssue,
	isInsideProject,
	primaryCheckout,
	primaryProjectFolder,
	sameSourcePath,
} from "./checkouts";
import { coolifyConfigSchema } from "./coolify";

/**
 * The hub's catalogue: projects, the dev servers each one runs, where their interfaces are and what they need first.
 * It lives in `services.json` next to the hub so it can be edited by hand; paths may use `${code}` for the folder
 * the projects live in.
 */

const ID = /^[a-z0-9][a-z0-9-]*$/;

const uiSchema = z.strictObject({
	label: z.string().min(1),
	/** A full URL, or a path on the service's own port. */
	url: z.string().min(1),
});

const serviceSchema = z.strictObject({
	/** What starts it; without one the hub only watches for it (it is started elsewhere). */
	command: z.string().min(1).optional(),
	/** Folder the command runs in, relative to the project; the project's own folder by default. */
	cwd: z.string().optional(),
	description: z.string().optional(),
	/** Opt in to the known Inference tray/CLI detached-listener readiness contract. */
	detachedListener: z.boolean().optional(),
	env: z.record(z.string(), z.string()).default({}),
	/** A path or URL that answers 2xx when the service is ready. */
	health: z.string().optional(),
	host: z.string().default("127.0.0.1"),
	id: z.string().regex(ID),
	name: z.string().min(1),
	/** What to start first: other services (`project/service`) and Docker Compose projects (`docker:<name>`). */
	needs: z.array(z.string()).default([]),
	port: z.number().int().min(1).max(65_535).optional(),
	/** Recovery of the raw process remains inside the hub-owned process tree. */
	restart: z.enum(["never", "on-failure", "always"]).default("never"),
	restartDelayMs: z.number().int().min(100).max(300_000).default(30_000),
	ui: z.array(uiSchema).default([]),
	/** Said before starting it: spends money, holds the GPU, needs a secret… */
	warn: z.string().optional(),
});

const projectSchema = z.strictObject({
	/** The Docker Compose project its dev servers use (databases, caches), or that runs the project itself. */
	compose: z
		.strictObject({
			file: z.string().min(1),
			/** Development-only overrides, applied after the primary compose file. */
			overrides: z.array(z.string().min(1)).default([]),
			project: z.string().min(1),
			/** The compose services the dev servers need; all of them when empty. */
			services: z.array(z.string().min(1)).default([]),
		})
		.optional(),
	description: z.string().optional(),
	id: z.string().regex(ID),
	/** Public development entrypoints, mapped to services rather than separate supervisors. */
	launch: z.record(z.string(), z.array(z.string()).min(1)).default({}),
	name: z.string().min(1),
	path: z.string().min(1),
	services: z.array(serviceSchema).default([]),
});

export const catalogueSchema = z.strictObject({
	/** Machine-owned redirects for older standalone copies of a project. */
	aliases: z.record(z.string(), z.string().min(1)).default({}),
	/** Where projects are, substituted for `${code}`. */
	code: z.string().default("D:/code"),
	/** The Coolify instance that runs these projects in production, read-only. */
	coolify: coolifyConfigSchema.optional(),
	/** Folders whose immediate project directories contain devhub.json. */
	discover: z.array(z.string()).default([]),
	/** Retired standalone copies remain on disk without becoming development projects. */
	exclude: z.array(z.string()).default([]),
	/** The hub's own port. */
	port: z.number().int().min(1).max(65_535).default(4700),
	projects: z.array(projectSchema),
});

export type Catalogue = z.infer<typeof catalogueSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type ServiceConfig = z.infer<typeof serviceSchema>;

/** A repository owns its dev contract; the machine supplies its absolute checkout path. */
export const manifestSchema = projectSchema.extend({
	path: z.string().default("."),
});

/** A service as the hub runs it: its full id, where it runs and where its pages are. */
export interface Service extends ServiceConfig {
	/** `project/service`. */
	key: string;
	project: ProjectConfig;
	/** Absolute folder the command runs in. */
	workdir: string;
}

const CODE = /\$\{code\}/g;
const ABSOLUTE_URL = /^https?:\/\//;

const expand = (text: string, code: string): string =>
	text.replace(CODE, () => code);

/** The page URLs of a service: a path is on its own host and port. */
export function uiUrl(service: Service, url: string): string {
	if (ABSOLUTE_URL.test(url)) {
		return url;
	}
	const port = service.port ? `:${service.port}` : "";
	return `http://${service.host}${port}${url.startsWith("/") ? url : `/${url}`}`;
}

export function healthUrl(service: Service): string | null {
	return service.health ? uiUrl(service, service.health) : null;
}

export function servicesOf(catalogue: Catalogue): Service[] {
	return catalogue.projects.flatMap((project) =>
		project.services.map((service) => {
			const path = expand(project.path, catalogue.code);
			const cwd = service.cwd ? expand(service.cwd, catalogue.code) : "";
			return {
				...service,
				key: `${project.id}/${service.id}`,
				project: { ...project, path },
				workdir: cwd && isAbsolute(cwd) ? cwd : join(path, cwd),
			};
		})
	);
}

export const DOCKER_NEED = "docker:";

/** Every problem a catalogue has beyond its shape: repeated keys and needs that name nothing it has. */
export function catalogueIssues(catalogue: Catalogue): string[] {
	const issues: string[] = [];
	// A catalogue validation inspects each checkout once; a new validation always re-reads Git state.
	const sourceCache = new Map<string, string>();
	const projects = new Set<string>();
	for (const project of catalogue.projects) {
		if (projects.has(project.id)) {
			issues.push(`проект ${project.id} записан дважды`);
		}
		projects.add(project.id);
		const path = expand(project.path, catalogue.code);
		const issue = developmentSourceIssue(path, undefined, sourceCache);
		if (issue) {
			issues.push(`${project.id}: ${issue}`);
		}
	}
	const keys = new Set<string>();
	for (const service of servicesOf(catalogue)) {
		if (keys.has(service.key)) {
			issues.push(`${service.key} записан дважды`);
		}
		keys.add(service.key);
		const issue = developmentSourceIssue(
			service.project.path,
			service.workdir,
			sourceCache
		);
		if (issue) {
			issues.push(`${service.key}: ${issue}`);
		}
	}
	const composed = new Set(
		catalogue.projects.flatMap((project) =>
			project.compose ? [project.compose.project] : []
		)
	);
	for (const service of servicesOf(catalogue)) {
		for (const need of service.needs) {
			const known = need.startsWith(DOCKER_NEED)
				? composed.has(need.slice(DOCKER_NEED.length))
				: keys.has(need);
			if (!known) {
				issues.push(`${service.key} ждёт ${need}, а такого в списке нет`);
			}
		}
	}
	return [
		...issues,
		...launchIssues(catalogue, keys),
		...cycleIssues(servicesOf(catalogue)),
	];
}

function launchIssues(catalogue: Catalogue, keys: Set<string>): string[] {
	const issues: string[] = [];
	for (const project of catalogue.projects) {
		for (const [script, targets] of Object.entries(project.launch)) {
			for (const target of targets) {
				const key = target.includes("/") ? target : `${project.id}/${target}`;
				if (!keys.has(key)) {
					issues.push(
						`${project.id}: команда ${script} ссылается на неизвестный ${key}`
					);
				}
			}
		}
	}
	return issues;
}

function cycleIssues(services: Service[]): string[] {
	const issues: string[] = [];
	const visited = new Set<string>();
	const visit = (key: string, chain: string[]): void => {
		if (chain.includes(key)) {
			issues.push(
				`сервисы ждут друг друга по кругу: ${[...chain, key].join(" → ")}`
			);
			return;
		}
		if (visited.has(key)) {
			return;
		}
		visited.add(key);
		for (const need of services.find((service) => service.key === key)?.needs ??
			[]) {
			if (!need.startsWith(DOCKER_NEED)) {
				visit(need, [...chain, key]);
			}
		}
	};
	for (const service of services) {
		visit(service.key, []);
	}
	return issues;
}

export async function loadManifest(folder: string): Promise<ProjectConfig> {
	const primary = primaryProjectFolder(folder);
	const file = join(primary, "devhub.json");
	const parsed = manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
	return { ...parsed, path: resolve(primary, parsed.path) };
}

/** Redirect a legacy clone or linked worktree to the machine's canonical project. */
export function canonicalProjectFolder(
	catalogue: Catalogue,
	folder: string
): string {
	let path = resolve(folder);
	const seen = new Set<string>();
	for (;;) {
		const alias = Object.entries(catalogue.aliases).find(([from]) =>
			isInsideProject(expand(from, catalogue.code), path)
		);
		if (!alias) {
			const primary = primaryProjectFolder(path);
			if (sameSourcePath(primary, path)) {
				return path;
			}
			path = primary;
			continue;
		}
		const identity = resolve(path).toLowerCase();
		if (seen.has(identity)) {
			throw new Error(`aliases содержит цикл для ${folder}`);
		}
		seen.add(identity);
		path = resolve(expand(alias[1], catalogue.code));
	}
}

function excludedFolder(catalogue: Catalogue, folder: string): boolean {
	return [...catalogue.exclude, ...Object.keys(catalogue.aliases)].some(
		(path) => isInsideProject(path, folder)
	);
}

async function discoveredProjects(
	catalogue: Catalogue,
	base: string
): Promise<ProjectConfig[]> {
	const found: ProjectConfig[] = [];
	const paths = new Set<string>();
	for (const configured of catalogue.discover) {
		const root = resolve(base, expand(configured, catalogue.code));
		if (!existsSync(root)) {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: a small machine-owned list of roots
		const entries = await readdir(root, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) {
				continue;
			}
			const folder = join(root, entry.name);
			const identity =
				process.platform === "win32" ? folder.toLowerCase() : folder;
			if (
				paths.has(identity) ||
				excludedFolder(catalogue, folder) ||
				!existsSync(join(folder, "devhub.json")) ||
				!sameSourcePath(folder, primaryCheckout(folder))
			) {
				continue;
			}
			paths.add(identity);
			found.push(
				// biome-ignore lint/performance/noAwaitInLoops: report a bad manifest with its filename
				await loadManifest(folder).catch((error: unknown) => {
					throw new Error(
						`${join(folder, "devhub.json")}: ${(error as Error).message}`
					);
				})
			);
		}
	}
	return found;
}

export async function loadCatalogue(file: string): Promise<Catalogue> {
	const parsed = catalogueSchema.safeParse(
		JSON.parse(await readFile(resolve(file), "utf8"))
	);
	if (!parsed.success) {
		throw new Error(
			`${file} заполнен неверно:\n${parsed.error.issues
				.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
				.join("\n")}`
		);
	}
	const base = dirname(resolve(file));
	const policy: Catalogue = {
		...parsed.data,
		aliases: Object.fromEntries(
			Object.entries(parsed.data.aliases).map(([from, to]) => [
				resolve(base, expand(from, parsed.data.code)),
				resolve(base, expand(to, parsed.data.code)),
			])
		),
		exclude: parsed.data.exclude.map((path) =>
			resolve(base, expand(path, parsed.data.code))
		),
	};
	const discovered = await discoveredProjects(policy, base);
	const discoveredIds = new Set(discovered.map((project) => project.id));
	const catalogue: Catalogue = {
		...policy,
		projects: [
			...parsed.data.projects.filter(
				(project) =>
					!(
						discoveredIds.has(project.id) ||
						excludedFolder(
							policy,
							resolve(base, expand(project.path, policy.code))
						)
					)
			),
			...discovered,
		],
	};
	const issues = catalogueIssues(catalogue);
	if (issues.length > 0) {
		throw new Error(`${file}:\n  ${issues.join("\n  ")}`);
	}
	return catalogue;
}
