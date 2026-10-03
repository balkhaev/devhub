// biome-ignore-all lint/suspicious/noUnnecessaryConditions: async lifecycle state and filesystem entries can change between invocations
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

import { isInsideProject, primaryCheckout, sameSourcePath } from "./checkouts";
import {
	type Catalogue,
	catalogueSchema,
	loadCatalogue,
	type ProjectConfig,
	servicesOf,
} from "./config";
import type { Hub } from "./hub";
import { filesystemReferenceBlockers } from "./project-references";
import { StageProject } from "./stage";

export interface DeletionPath {
	kind: "project" | "worktree" | "alias";
	path: string;
}

export interface DeletionPlan {
	blockers: string[];
	id: string;
	name: string;
	paths: DeletionPath[];
	token: string;
	warnings: string[];
}

interface MovedPath {
	from: string;
	identity: string;
	to: string;
}

interface Snapshot {
	catalogue: Catalogue;
	digest: string;
	identities: Record<string, string>;
	plan: DeletionPlan;
	policy: Catalogue;
	raw: string;
}

const PLAN_TTL_MS = 10 * 60_000;
const SLASH = /\\/g;
const CODE = /\$\{code\}/g;
const PATH_END = /[\s"';,]/;
const normalize = (path: string) =>
	resolve(path).replace(SLASH, "/").toLowerCase();
const expand = (path: string, code: string) => path.replace(CODE, () => code);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Lexical containment keeps the deletion boundary at the reviewed directory, even for junctions. */
function contains(root: string, path: string): boolean {
	const from = relative(resolve(root), resolve(path));
	return (
		from === "" ||
		!(
			from === ".." ||
			from.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(from)
		)
	);
}

function identity(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${path}: папка проекта не должна быть ссылкой`);
	}
	return `${normalize(realpathSync.native(path))}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

/** Stale Git registrations are harmless; existing unrelated folders are never accepted as worktrees. */
function linkedCheckouts(root: string, blockers: string[]): string[] {
	if (!existsSync(join(root, ".git"))) {
		return [];
	}
	const listed = spawnSync(
		"git",
		["-C", root, "worktree", "list", "--porcelain", "-z"],
		{ encoding: "utf8", windowsHide: true }
	);
	if (listed.status !== 0) {
		blockers.push(`Не удалось прочитать worktree проекта ${root}`);
		return [];
	}
	return listed.stdout
		.split("\0")
		.filter((entry) => entry.startsWith("worktree "))
		.map((entry) => resolve(entry.slice("worktree ".length)))
		.filter((path) => !sameSourcePath(path, root) && existsSync(path))
		.filter((path) => {
			try {
				if (sameSourcePath(primaryCheckout(path), root)) {
					return true;
				}
			} catch {
				/* A stale or replaced checkout cannot authorize deletion. */
			}
			blockers.push(
				`Запись worktree ${path} теперь указывает на другую папку или репозиторий`
			);
			return false;
		});
}

function protectedPath(
	path: string,
	root: string,
	catalogue: Catalogue,
	id: string
): string | null {
	const boundaries = [
		root,
		homedir(),
		catalogue.code,
		...catalogue.discover.map((folder) => expand(folder, catalogue.code)),
		parse(path).root,
	];
	if (
		boundaries.some(
			(boundary) => contains(path, boundary) || isInsideProject(path, boundary)
		)
	) {
		return `${path}: системная папка, DevHub или корень коллекции проектов`;
	}
	for (const project of catalogue.projects.filter((entry) => entry.id !== id)) {
		const other = expand(project.path, catalogue.code);
		if (
			contains(path, other) ||
			contains(other, path) ||
			isInsideProject(path, other) ||
			isInsideProject(other, path)
		) {
			return `${path}: пересекается с проектом ${project.name} (${other})`;
		}
	}
	return null;
}

function mentionsPath(value: string, path: string): boolean {
	if (isAbsolute(value) && existsSync(value) && isInsideProject(path, value)) {
		return true;
	}
	const text = value.replace(SLASH, "/").toLowerCase();
	const target = normalize(path);
	let at = text.indexOf(target);
	while (at >= 0) {
		const after = text[at + target.length];
		if (after === undefined || after === "/" || PATH_END.test(after)) {
			return true;
		}
		at = text.indexOf(target, at + target.length);
	}
	return false;
}

function retainedAliases(
	aliases: Record<string, string>,
	removed: string[],
	code: string,
	base: string
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(aliases).filter(
			([from, to]) =>
				!removed.some(
					(path) =>
						contains(path, resolve(base, expand(from, code))) ||
						contains(path, resolve(base, expand(to, code)))
				)
		)
	);
}

function deletionRoots(
	catalogue: Catalogue,
	main: string,
	blockers: string[]
): DeletionPath[] {
	const paths: DeletionPath[] = [{ kind: "project", path: main }];
	for (const [alias, target] of Object.entries(catalogue.aliases)) {
		if (sameSourcePath(target, main) && existsSync(alias)) {
			paths.push({ kind: "alias", path: resolve(alias) });
		}
	}
	for (const path of [...paths]) {
		try {
			if (!sameSourcePath(primaryCheckout(path.path), path.path)) {
				blockers.push(`${path.path}: требуется основной checkout`);
			}
			paths.push(
				...linkedCheckouts(path.path, blockers).map((folder) => ({
					kind: "worktree" as const,
					path: folder,
				}))
			);
		} catch (error) {
			blockers.push((error as Error).message);
		}
	}
	const unique = [
		...new Map(paths.map((path) => [normalize(path.path), path])).values(),
	];
	const roots = unique.filter(
		(path) =>
			!unique.some((other) => other !== path && contains(other.path, path.path))
	);
	return roots;
}

function dependencyBlockers(
	catalogue: Catalogue,
	project: ProjectConfig,
	roots: DeletionPath[]
): string[] {
	const { id } = project;
	const blockers: string[] = [];
	const removedKeys = new Set(
		project.services.map((service) => `${id}/${service.id}`)
	);
	for (const service of servicesOf(catalogue).filter(
		(entry) => entry.project.id !== id
	)) {
		for (const need of service.needs) {
			if (
				removedKeys.has(need) ||
				(project.compose && need === `docker:${project.compose.project}`)
			) {
				blockers.push(
					`${service.key} зависит от ${need}. Сначала уберите эту зависимость.`
				);
			}
		}
		for (const path of roots) {
			if (
				[
					service.command ?? "",
					service.workdir,
					...Object.values(service.env),
				].some((value) => mentionsPath(value, path.path))
			) {
				blockers.push(
					`${service.key} использует файлы в ${path.path}. Сначала перенесите данные и обновите devhub.json.`
				);
			}
		}
	}
	blockers.push(...projectDependencyBlockers(catalogue, project, removedKeys));
	return blockers;
}

function projectDependencyBlockers(
	catalogue: Catalogue,
	project: ProjectConfig,
	removedKeys: Set<string>
): string[] {
	const { id } = project;
	const blockers: string[] = [];
	for (const other of catalogue.projects.filter((entry) => entry.id !== id)) {
		if (project.compose && other.compose?.project === project.compose.project) {
			blockers.push(
				`Docker ${project.compose.project} также используется проектом ${other.id}. Сначала разделите Compose-проекты.`
			);
		}
		for (const targets of Object.values(other.launch)) {
			if (targets.some((target) => removedKeys.has(target))) {
				blockers.push(
					`Команда проекта ${other.id} запускает сервисы ${id}. Сначала измените devhub.json.`
				);
			}
		}
	}
	return blockers;
}

/** Repository deletion is a separate lifecycle from Compose: named volumes are retained. */
export class Projects {
	private readonly plans = new Map<
		string,
		{ digest: string; expires: number; id: string }
	>();
	private deleting = false;
	private readonly file: string;
	private readonly root: string;
	private readonly hub: Hub;

	constructor(hub: Hub, root: string) {
		this.hub = hub;
		this.root = resolve(root);
		this.file = join(this.root, "services.json");
	}

	async plan(id: string): Promise<DeletionPlan> {
		await this.hub.refresh(true);
		const snapshot = await this.snapshot(id);
		for (const [token, plan] of this.plans) {
			if (plan.expires < Date.now()) {
				this.plans.delete(token);
			}
		}
		const token = randomUUID();
		this.plans.set(token, {
			digest: snapshot.digest,
			expires: Date.now() + PLAN_TTL_MS,
			id,
		});
		return { ...snapshot.plan, token };
	}

	private async snapshot(id: string): Promise<Snapshot> {
		const raw = await readFile(this.file, "utf8");
		const policy = catalogueSchema.parse(JSON.parse(raw));
		const catalogue = await loadCatalogue(this.file);
		const project = catalogue.projects.find((entry) => entry.id === id);
		if (!project) {
			throw new Error(`нет проекта ${id}`);
		}
		const main = resolve(
			dirname(this.file),
			expand(project.path, catalogue.code)
		);
		const blockers: string[] = [];
		const warnings = [
			"Все файлы в перечисленных папках, включая незакоммиченные изменения, данные и настройки, будут удалены безвозвратно.",
			"Docker volumes сохраняются. Внешние папки по символьным ссылкам и junction не удаляются.",
		];
		const roots = deletionRoots(catalogue, main, blockers);
		const identities: Record<string, string> = {};
		for (const path of roots) {
			const collections = [
				catalogue.code,
				...catalogue.discover.map((folder) => expand(folder, catalogue.code)),
			];
			if (
				path.kind !== "worktree" &&
				!collections.some(
					(collection) =>
						contains(resolve(dirname(this.file), collection), path.path) &&
						isInsideProject(resolve(dirname(this.file), collection), path.path)
				)
			) {
				blockers.push(
					`${path.path}: папка находится вне коллекций проектов из services.json`
				);
			}
			const problem = protectedPath(path.path, this.root, catalogue, id);
			if (problem) {
				blockers.push(problem);
			}
			try {
				identities[path.path] = identity(path.path);
			} catch (error) {
				blockers.push((error as Error).message);
			}
		}
		blockers.push(...dependencyBlockers(catalogue, project, roots));
		blockers.push(...(await filesystemReferenceBlockers(catalogue, id, roots)));
		const external =
			this.hub.current.projects
				.find((entry) => entry.id === id)
				?.services.filter((service) => service.status === "external") ?? [];
		blockers.push(
			...external.map(
				(service) =>
					`${service.name} запущен вне DevHub (PID ${service.pid}). Сначала остановите его.`
			)
		);
		if (project.compose) {
			warnings.push(
				`Docker ${project.compose.project} будет остановлен; контейнеры и volumes останутся.`
			);
		}
		const plan: DeletionPlan = {
			blockers: [...new Set(blockers)],
			id,
			name: project.name,
			paths: roots,
			token: "",
			warnings,
		};
		return {
			catalogue,
			digest: hash(JSON.stringify({ identities, plan, raw })),
			identities,
			plan,
			policy,
			raw,
		};
	}

	async delete(id: string, token: string): Promise<{ deleted: string[] }> {
		if (this.deleting) {
			throw new Error("Удаление другого проекта ещё выполняется");
		}
		const reviewed = this.plans.get(token);
		if (!reviewed || reviewed.id !== id || reviewed.expires < Date.now()) {
			throw new Error("Список папок устарел. Откройте удаление заново.");
		}
		this.deleting = true;
		const moved: MovedPath[] = [];
		const stageLocks: (() => void)[] = [];
		let release: (() => void) | undefined;
		let committed = false;
		try {
			await this.hub.refresh(true);
			const snapshot = await this.snapshot(id);
			if (snapshot.digest !== reviewed.digest) {
				throw new Error(
					"Проект или список папок изменился. Обновите список перед удалением."
				);
			}
			if (snapshot.plan.blockers.length) {
				throw new Error(snapshot.plan.blockers.join("\n"));
			}
			this.plans.delete(token);
			for (const path of snapshot.plan.paths.filter(
				(entry) => entry.kind !== "worktree"
			)) {
				if (existsSync(join(path.path, ".devhub", "worktree.json"))) {
					stageLocks.push(
						new StageProject(
							path.path,
							join(this.root, ".state", "stage")
						).acquireLock()
					);
				}
			}
			release = await this.hub.quiesceProject(id);
			const compose = snapshot.catalogue.projects.find(
				(project) => project.id === id
			)?.compose;
			if (
				compose &&
				this.hub.current.docker.projects.some(
					(project) =>
						project.name === compose.project &&
						project.containers.some((container) => container.running)
				)
			) {
				await this.hub.composeAction(compose.project, "stop");
			}
			// Repeat the identity/catalogue review after waiting for running owners to exit.
			const current = await this.snapshot(id);
			if (current.digest !== reviewed.digest) {
				throw new Error(
					"Проект изменился во время остановки. Обновите список перед удалением."
				);
			}
			await this.moveRoots(id, snapshot.plan.paths, moved, snapshot.identities);
			const removed = snapshot.plan.paths.map((path) => path.path);
			const keptAliases = retainedAliases(
				snapshot.policy.aliases,
				removed,
				snapshot.policy.code,
				dirname(this.file)
			);
			const nextPolicy = {
				...snapshot.policy,
				aliases: keptAliases,
				exclude: [...new Set([...snapshot.policy.exclude, ...removed])],
				projects: snapshot.policy.projects.filter(
					(project) => project.id !== id
				),
			};
			const temporary = `${this.file}.${randomUUID()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(nextPolicy, null, 2)}\n`);
			// Review after preparing the replacement, immediately before replacing the machine catalogue.
			if ((await readFile(this.file, "utf8")) !== snapshot.raw) {
				await rm(temporary);
				throw new Error("services.json изменился во время удаления");
			}
			await rename(temporary, this.file);
			committed = true;
			await this.hub.replaceCatalogue({
				...snapshot.catalogue,
				aliases: retainedAliases(
					snapshot.catalogue.aliases,
					removed,
					snapshot.catalogue.code,
					dirname(this.file)
				),
				exclude: nextPolicy.exclude,
				projects: snapshot.catalogue.projects.filter(
					(project) => project.id !== id
				),
			});
			await this.record(id, moved, "removing");
			await this.removeRoots(moved);
			await this.record(id, moved, "deleted");
			return { deleted: removed };
		} catch (error) {
			if (committed) {
				await this.record(id, moved, "cleanup-failed");
				throw new Error(
					`Проект убран из DevHub, но часть файлов не удалена: ${moved
						.filter((path) => existsSync(path.to))
						.map((path) => path.to)
						.join(", ")}. ${(error as Error).message}`,
					{ cause: error }
				);
			}
			await this.rollback(moved);
			throw error;
		} finally {
			release?.();
			for (const unlock of stageLocks.reverse()) {
				unlock();
			}
			this.deleting = false;
		}
	}

	private async moveRoots(
		id: string,
		paths: DeletionPath[],
		moved: MovedPath[],
		identities: Record<string, string>
	): Promise<void> {
		const scheduled = paths.map((path) => ({
			from: path.path,
			identity: identities[path.path] ?? "",
			to: join(dirname(path.path), `.devhub-delete-${randomUUID()}`),
		}));
		// Record every intended destination before the first move, so an interrupted preparation is recoverable.
		await this.record(id, scheduled, "preparing");
		for (const path of scheduled) {
			const { to } = path;
			const before = identity(path.from);
			if (before !== path.identity) {
				throw new Error(`Папка изменилась перед удалением: ${path.from}`);
			}
			// The resolved, absolute source is an exact reviewed root; target stays in its verified parent.
			if (!contains(dirname(path.from), to) || existsSync(to)) {
				throw new Error(`Небезопасный временный путь ${to}`);
			}
			// biome-ignore lint/performance/noAwaitInLoops: move serially so an error can roll back the complete prefix
			await rename(path.from, to);
			moved.push(path);
			const after = lstatSync(to);
			if (
				!before.endsWith(`:${after.dev}:${after.ino}:${after.birthtimeMs}`) ||
				after.isSymbolicLink() ||
				!after.isDirectory()
			) {
				throw new Error(
					`Папка изменилась при подготовке удаления: ${path.from}`
				);
			}
		}
	}

	private async removeRoots(moved: MovedPath[]): Promise<void> {
		for (const path of moved) {
			const stat = lstatSync(path.to);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				!contains(dirname(path.from), path.to) ||
				!path.identity.endsWith(`:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`)
			) {
				throw new Error(`Удаляемая папка изменилась: ${path.to}`);
			}
			// Node removes junction entries themselves; it does not traverse their external targets.
			// biome-ignore lint/performance/noAwaitInLoops: one checked root is removed at a time for a useful failure journal
			await rm(path.to, {
				force: false,
				maxRetries: 3,
				recursive: true,
				retryDelay: 150,
			});
		}
	}

	private async rollback(moved: MovedPath[]): Promise<void> {
		for (const path of moved.reverse()) {
			if (existsSync(path.to) && !existsSync(path.from)) {
				// biome-ignore lint/performance/noAwaitInLoops: rollback in reverse rename order
				await rename(path.to, path.from);
			}
		}
	}

	private async record(
		id: string,
		paths: unknown,
		status: string
	): Promise<void> {
		const folder = join(this.root, ".state", "deletions");
		await mkdir(folder, { recursive: true });
		await writeFile(
			join(folder, `${id}.json`),
			`${JSON.stringify({ id, paths, status, updatedAt: new Date().toISOString() }, null, 2)}\n`
		);
	}
}
