import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { YAML } from "bun";

import { sourcePath } from "./checkouts";
import type { Catalogue, ProjectConfig } from "./config";
import type { DeletionPath } from "./projects";

const MAX_ENTRIES = 200_000;
const MAX_FILES = 15_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_DATA_DEPTH = 32;
const FILE_BATCH = 32;
const CONFIG_OR_CODE =
	/\.(?:toml|ya?ml|jsonc?|ini|conf|cfg|ts|tsx|js|jsx|mjs|cjs|py|go|rs|ps1|sh|bat|cmd)$/i;
const ENV_FILE = /^(?:\.env(?:\..+)?|config\.env)$/;
const EXAMPLE_FILE = /(?:example|sample|template)/i;
const TEST_FILE = /(?:\.|-)(?:test|spec)\.[^.]+$/i;
const PACKAGE_ROOT = /^(?:apps|packages)[\\/][^\\/]+$/;
const QUOTED = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const BACKSLASH = /\\/g;
const SLASHES = /\/+/g;
const PATH_PARTS = /[\\/]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Windows rejects these bytes in filesystem paths.
const INVALID_WINDOWS_PATH = /[<>"|?*\x00-\x1f]/;
const RELATIVE_PATH = /^\.\.?[\\/]/;
const PATH_START = /[\s"'`=:([{,]/;
const PATH_END = /[\s"'`;,)}\]]/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const ENV_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}/g;
const LINE_BREAK = /\r?\n/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const GENERATED_FOLDER =
	/^(?:\.?venv(?:[-_.]|$)|\.next(?:[-_.]|$)|test-results(?:[-_.]|$)|playwright-report(?:[-_.]|$)|site-packages$|vendor$|\.openai$|\.vinext$|\.wrangler$|\.svelte-kit$)/;
// biome-ignore lint/suspicious/noTemplateCurlyInString: catalogue path expansion uses this literal placeholder.
const CODE_TOKEN = "${code}";
const HARD_SKIP = new Set([
	".git",
	".claude",
	".codex",
	".agents",
	".worktrees",
	".devhub",
	".cursor",
	".github",
	".memory",
	"node_modules",
	".venv",
	".venv-laya",
	".venv-native",
	"venv",
	"__pycache__",
	".pytest_cache",
	".ruff_cache",
	".next",
	".turbo",
	".nx",
	"dist",
	"build",
	"coverage",
	"docs",
	"references",
	"test",
	"tests",
	"fixtures",
]);
const DATA_SKIP = new Set([
	"runtime",
	"artifacts",
	"models",
	"weights",
	"data",
	"storage",
	"output",
	"outputs",
	"media",
	"downloads",
	".assets",
	".montage",
	"assets",
	"research",
	".state",
	".logs",
	".scratch",
	".cache",
	"logs",
	"tmp",
	"temp",
	"snapshots",
	"archives",
]);
const FILE_SKIP = new Set([
	"package-lock.json",
	"tsconfig.tsbuildinfo",
	"pnpm-lock.yaml",
	"bun.lock",
	"uv.lock",
	"composer.lock",
	"tsconfig.json",
	"biome.json",
	"biome.jsonc",
	"components.json",
	"original-scripts.json",
	"original-launchers.json",
]);

interface Scan {
	blockers: Set<string>;
	bytes: number;
	entries: number;
	files: number;
	paths: Map<string, string>;
	roots: DeletionPath[];
}

function normalized(value: string): string {
	return value.replace(BACKSLASH, "/").replace(SLASHES, "/").toLowerCase();
}

function ownerFile(project: ProjectConfig, file: string): string {
	return `${project.id}: ${file}`;
}

function failure(
	scan: Scan,
	project: ProjectConfig,
	file: string,
	reason: string
) {
	scan.blockers.add(
		`${ownerFile(project, file)}: ${reason}; проверка зависимостей не завершена`
	);
}

function literalReferences(
	text: string,
	scan: Scan,
	project: ProjectConfig,
	file: string
) {
	const value = normalized(text);
	for (const root of scan.roots) {
		const target = normalized(resolve(root.path));
		let at = value.indexOf(target);
		while (at >= 0) {
			const before = value[at - 1];
			const after = value[at + target.length];
			if (
				(!before || PATH_START.test(before)) &&
				(!after || after === "/" || PATH_END.test(after))
			) {
				scan.blockers.add(
					`${ownerFile(project, file)} ссылается на удаляемую папку ${root.path}`
				);
				break;
			}
			at = value.indexOf(target, at + target.length);
		}
	}
}

function resolvedReference(
	value: string,
	base: string,
	scan: Scan,
	project: ProjectConfig,
	file: string
) {
	if (!(isAbsolute(value) || RELATIVE_PATH.test(value))) {
		return;
	}
	if (process.platform === "win32" && INVALID_WINDOWS_PATH.test(value)) {
		return;
	}
	const path = resolve(base, value);
	const cachedPath = (folder: string): string => {
		const known = scan.paths.get(folder);
		if (known !== undefined) {
			return known;
		}
		const canonical = sourcePath(folder);
		scan.paths.set(folder, canonical);
		return canonical;
	};
	const ownerOffset = relative(project.path, path);
	// Links beneath inspected source/data folders are verified separately during traversal.
	// Resolve paths outside those folders (including generated trees) individually.
	const withinInspectedOwner =
		insideOffset(ownerOffset) &&
		!ownerOffset
			.split(PATH_PARTS)
			.some((part) => HARD_SKIP.has(part) || GENERATED_FOLDER.test(part));
	const canonical = withinInspectedOwner ? path : cachedPath(path);
	for (const root of scan.roots) {
		const offset = relative(cachedPath(root.path), canonical);
		if (insideOffset(offset)) {
			scan.blockers.add(
				`${ownerFile(project, file)} использует файлы в удаляемой папке ${root.path}`
			);
		}
	}
}

function insideOffset(offset: string): boolean {
	return (
		offset === "" ||
		!(
			offset === ".." ||
			offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(offset)
		)
	);
}

function decodeLiteral(value: string): string {
	return value
		.slice(1, -1)
		.replaceAll("\\\\", "\\")
		.replaceAll("\\/", "/")
		.replaceAll('\\"', '"')
		.replaceAll("\\'", "'");
}

function envValues(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of text.split(LINE_BREAK)) {
		const [, key, value] = ENV_LINE.exec(line) ?? [];
		if (!key || value === undefined) {
			continue;
		}
		result[key] =
			value.startsWith('"') || value.startsWith("'")
				? decodeLiteral(value)
				: (value.split(" #")[0]?.trim() ?? "");
	}
	return result;
}

async function junctionReference(
	path: string,
	scan: Scan,
	project: ProjectConfig
) {
	try {
		const target = resolve(path, "..", await readlink(path));
		resolvedReference(target, project.path, scan, project, path);
	} catch {
		failure(scan, project, path, "Не удалось проверить цель ссылки");
	}
}

async function inspectEntry(path: string, scan: Scan, project: ProjectConfig) {
	scan.entries += 1;
	if (scan.entries > MAX_ENTRIES) {
		throw new Error("Превышен предел числа файлов и папок");
	}
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) {
		await junctionReference(path, scan, project);
	}
	return stat;
}

function generatedFolder(
	project: ProjectConfig,
	file: string,
	name: string
): boolean {
	return (
		HARD_SKIP.has(name) ||
		GENERATED_FOLDER.test(name) ||
		relative(project.path, file) === "qa"
	);
}

function dataFolder(
	project: ProjectConfig,
	file: string,
	name: string
): boolean {
	const parent = relative(project.path, resolve(file, ".."));
	return (
		(DATA_SKIP.has(name) && parent === "") ||
		((name === "tmp" || name === "temp") && PACKAGE_ROOT.test(parent))
	);
}

/** Walk bounded data-directory metadata for nested junctions; never read data/model bytes. */
async function dataEntry(
	entry: Dirent,
	file: string,
	scan: Scan,
	project: ProjectConfig
): Promise<boolean> {
	scan.entries += 1;
	if (scan.entries > MAX_ENTRIES) {
		throw new Error("Directory metadata budget exceeded");
	}
	if (entry.isDirectory()) {
		return !generatedFolder(project, file, entry.name);
	}
	const stat = await inspectEntry(file, scan, project);
	return (
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		!generatedFolder(project, file, entry.name)
	);
}

async function dataJunctions(
	folder: string,
	scan: Scan,
	project: ProjectConfig
) {
	const folders = [{ depth: 0, folder }];
	for (let offset = 0; offset < folders.length; ) {
		const batch = folders.slice(offset, offset + FILE_BATCH);
		offset += batch.length;
		// biome-ignore lint/performance/noAwaitInLoops: bounded batches inspect metadata only, with at most 32 concurrent directory/link reads.
		const results = await Promise.allSettled(
			batch.map(async (directory) => {
				if (directory.depth > MAX_DATA_DEPTH) {
					throw new Error("Data directory graph is too deep to verify");
				}
				for (const entry of await readdir(directory.folder, {
					withFileTypes: true,
				})) {
					if (entry.isFile()) {
						continue;
					}
					const file = join(directory.folder, entry.name);
					// biome-ignore lint/performance/noAwaitInLoops: individual link checks share the fixed directory batch concurrency limit.
					const descend = await dataEntry(entry, file, scan, project);
					if (descend) {
						folders.push({ depth: directory.depth + 1, folder: file });
					}
				}
			})
		);
		for (const [index, result] of results.entries()) {
			const directory = batch[index];
			if (directory && result.status === "rejected") {
				failure(
					scan,
					project,
					directory.folder,
					"Не удалось полностью проверить ссылки в данных"
				);
			}
		}
	}
}

function candidateFile(name: string): boolean {
	return (
		!(FILE_SKIP.has(name) || EXAMPLE_FILE.test(name) || TEST_FILE.test(name)) &&
		(CONFIG_OR_CODE.test(name) || ENV_FILE.test(name))
	);
}

async function sourceEntry(
	entry: Dirent,
	folder: string,
	scan: Scan,
	project: ProjectConfig
): Promise<{ file: string; name: string } | null> {
	const file = join(folder, entry.name);
	if (entry.isSymbolicLink()) {
		await junctionReference(file, scan, project);
		return null;
	}
	if (entry.isDirectory()) {
		if (generatedFolder(project, file, entry.name)) {
			return null;
		}
		return { file, name: entry.name };
	}
	if (entry.isFile() && candidateFile(entry.name)) {
		const stat = await inspectEntry(file, scan, project);
		if (stat.isFile()) {
			await inspectText(file, stat.size, scan, project);
		}
	}
	return null;
}

async function inspectText(
	file: string,
	size: number,
	scan: Scan,
	project: ProjectConfig
) {
	scan.files += 1;
	scan.bytes += size;
	if (
		scan.files > MAX_FILES ||
		size > MAX_FILE_BYTES ||
		scan.bytes > MAX_TOTAL_BYTES
	) {
		throw new Error("Превышен безопасный предел проверки конфигурации");
	}
	const text = await readFile(file, "utf8");
	if (text.includes("\0")) {
		throw new Error("Файл конфигурации содержит бинарные данные");
	}
	literalReferences(text, scan, project, file);
	for (const match of text.matchAll(QUOTED)) {
		resolvedReference(
			decodeLiteral(match[0]),
			resolve(file, ".."),
			scan,
			project,
			file
		);
	}
	if (ENV_FILE.test(basename(file))) {
		for (const value of Object.values(envValues(text))) {
			resolvedReference(value, resolve(file, ".."), scan, project, file);
		}
	}
}

async function walk(
	folder: string,
	scan: Scan,
	project: ProjectConfig
): Promise<void> {
	try {
		const entries = await readdir(folder, { withFileTypes: true });
		const directories: { file: string; name: string }[] = [];
		for (let offset = 0; offset < entries.length; offset += FILE_BATCH) {
			// biome-ignore lint/performance/noAwaitInLoops: independent files are read in fixed-size batches under the shared byte budget.
			const results = await Promise.allSettled(
				entries
					.slice(offset, offset + FILE_BATCH)
					.map((entry) => sourceEntry(entry, folder, scan, project))
			);
			for (const result of results) {
				if (result.status === "rejected") {
					failure(
						scan,
						project,
						folder,
						"Не удалось полностью проверить конфигурацию или ссылки"
					);
				} else if (result.value) {
					directories.push(result.value);
				}
			}
		}
		for (const directory of directories) {
			if (dataFolder(project, directory.file, directory.name)) {
				// biome-ignore lint/performance/noAwaitInLoops: directory traversal stays serial so file batches retain a fixed global concurrency bound.
				await dataJunctions(directory.file, scan, project);
			} else {
				await walk(directory.file, scan, project);
			}
		}
	} catch {
		failure(
			scan,
			project,
			folder,
			"Не удалось полностью проверить конфигурацию или ссылки"
		);
	}
}

function bindSource(volume: unknown): string | null {
	if (
		typeof volume === "object" &&
		volume &&
		"type" in volume &&
		volume.type === "bind" &&
		"source" in volume &&
		typeof volume.source === "string"
	) {
		return volume.source;
	}
	if (typeof volume !== "string") {
		return null;
	}
	const start = DRIVE_PATH.test(volume) ? 2 : 0;
	const end = volume.indexOf(":", start);
	return end < 0 ? null : volume.slice(0, end);
}

function expandedSource(
	source: string,
	env: Record<string, string>
): string | null {
	let missing = false;
	const expanded = source.replace(
		ENV_VARIABLE,
		(
			_,
			key: string,
			operator: string | undefined,
			fallback: string | undefined
		) => {
			const value = env[key];
			if (value !== undefined && (value || operator !== ":-")) {
				return value;
			}
			if (fallback !== undefined) {
				return fallback;
			}
			missing = true;
			return "";
		}
	);
	return missing ? null : expanded;
}

function composeVolume(
	volume: unknown,
	env: Record<string, string>,
	file: string,
	project: ProjectConfig,
	scan: Scan
) {
	const source = bindSource(volume);
	if (!source) {
		return;
	}
	const expanded = expandedSource(source, env);
	if (expanded === null) {
		failure(
			scan,
			project,
			file,
			"Не удалось определить источник Docker mount из переменной окружения"
		);
		return;
	}
	const explicitBind =
		typeof volume === "object" &&
		volume &&
		"type" in volume &&
		volume.type === "bind";
	const location =
		explicitBind && !(isAbsolute(expanded) || RELATIVE_PATH.test(expanded))
			? `./${expanded}`
			: expanded;
	resolvedReference(location, resolve(file, ".."), scan, project, file);
}

async function composeEnvironment(
	project: ProjectConfig
): Promise<Record<string, string>> {
	try {
		return {
			...envValues(await readFile(join(project.path, ".env"), "utf8")),
			...process.env,
		} as Record<string, string>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		return process.env as Record<string, string>;
	}
}

async function composeLayer(file: string, project: ProjectConfig, scan: Scan) {
	try {
		resolvedReference(file, project.path, scan, project, file);
		if ((await lstat(file)).size > MAX_FILE_BYTES) {
			throw new Error("Oversized Compose configuration");
		}
		const model = YAML.parse(await readFile(file, "utf8")) as {
			services?: Record<string, { volumes?: unknown[] }>;
		};
		const env = await composeEnvironment(project);
		for (const service of Object.values(model.services ?? {})) {
			for (const volume of service.volumes ?? []) {
				composeVolume(volume, env, file, project, scan);
			}
		}
	} catch {
		failure(scan, project, file, "Не удалось проверить Docker bind mounts");
	}
}

async function composeReferences(project: ProjectConfig, scan: Scan) {
	if (!project.compose) {
		return;
	}
	for (const layer of [project.compose.file, ...project.compose.overrides]) {
		const file = resolve(project.path, layer);
		// biome-ignore lint/performance/noAwaitInLoops: each layer has its own bounded parsing and failure report.
		await composeLayer(file, project, scan);
	}
}

/** Inspect live source/configuration and incoming junctions without exposing configuration values or reading model/data contents. */
export async function filesystemReferenceBlockers(
	catalogue: Catalogue,
	id: string,
	roots: DeletionPath[]
): Promise<string[]> {
	const scan: Scan = {
		blockers: new Set(),
		bytes: 0,
		entries: 0,
		files: 0,
		paths: new Map(),
		roots,
	};
	for (const project of catalogue.projects.filter((entry) => entry.id !== id)) {
		try {
			const absolute = resolve(
				project.path.replaceAll(CODE_TOKEN, catalogue.code)
			);
			const owner = { ...project, path: absolute };
			// biome-ignore lint/performance/noAwaitInLoops: projects share a strict global file/byte budget.
			await walk(owner.path, scan, owner);
			await composeReferences(owner, scan);
		} catch {
			failure(
				scan,
				project,
				project.path,
				"Не удалось безопасно проверить проект"
			);
		}
	}
	return [...scan.blockers].sort();
}
