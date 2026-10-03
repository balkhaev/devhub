import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const LINES = /\r?\n/;

/** Resolve junctions as well as path spelling before comparing source folders. */
export function sourcePath(folder: string): string {
	const absolute = resolve(folder);
	return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

export function sameSourcePath(a: string, b: string): boolean {
	const normalize = (folder: string) => {
		const path = sourcePath(folder);
		return process.platform === "win32" ? path.toLowerCase() : path;
	};
	return normalize(a) === normalize(b);
}

/** Git's shared directory identifies the primary checkout independently of branch names. */
export function primaryCheckout(folder: string): string {
	const path = sourcePath(folder);
	if (!existsSync(path)) {
		return path;
	}
	const result = spawnSync(
		"git",
		[
			"-C",
			path,
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-dir",
			"--git-common-dir",
		],
		{ encoding: "utf8", windowsHide: true }
	);
	if (result.status !== 0) {
		if (existsSync(join(path, ".git"))) {
			throw new Error(
				`не удалось определить основной checkout Git для ${path}`
			);
		}
		// Non-Git projects (including temporary test fixtures) remain supported.
		return path;
	}
	const [top, gitDir, commonDir] = result.stdout.trim().split(LINES);
	if (!(top && gitDir && commonDir)) {
		throw new Error(`Git не вернул checkout для ${path}`);
	}
	if (sameSourcePath(gitDir, commonDir)) {
		return sourcePath(top);
	}
	const worktrees = spawnSync(
		"git",
		["--git-dir", commonDir, "worktree", "list", "--porcelain"],
		{ encoding: "utf8", windowsHide: true }
	);
	const first = worktrees.stdout?.split(LINES)[0];
	if (worktrees.status !== 0 || !first?.startsWith("worktree ")) {
		throw new Error(`не удалось определить основной checkout для ${path}`);
	}
	return sourcePath(first.slice("worktree ".length));
}

/** A service may use a package subfolder, but never another checkout or a junction to it. */
export function isInsideProject(projectRoot: string, folder: string): boolean {
	const path = relative(sourcePath(projectRoot), sourcePath(folder));
	return (
		path === "" ||
		!(
			path === ".." ||
			path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(path)
		)
	);
}

export function developmentSourceIssue(
	projectRoot: string,
	workdir?: string,
	cache?: Map<string, string>
): string | null {
	const cachedPrimary = (folder: string): string => {
		const key = `primary:${sourcePath(folder)}`;
		const known = cache?.get(key);
		if (known) {
			return known;
		}
		const primary = primaryCheckout(folder);
		cache?.set(key, primary);
		return primary;
	};
	const primary = cachedPrimary(projectRoot);
	if (!sameSourcePath(projectRoot, primary)) {
		return `dev запускается только из основной папки ${primary}; ${projectRoot} является worktree или вложенной папкой`;
	}
	const policyFile = join(primary, ".devhub", "worktree.json");
	if (existsSync(policyFile)) {
		const policy = JSON.parse(readFileSync(policyFile, "utf8")) as {
			stageBranch?: string;
		};
		const branchKey = `branch:${primary}`;
		let branch = cache?.get(branchKey);
		if (branch === undefined) {
			branch =
				spawnSync("git", ["-C", primary, "symbolic-ref", "--short", "HEAD"], {
					encoding: "utf8",
					windowsHide: true,
				}).stdout?.trim() ?? "";
			cache?.set(branchKey, branch);
		}
		if (policy.stageBranch && branch !== policy.stageBranch) {
			return `dev проекта ${primary} должен запускаться на ветке ${policy.stageBranch}; сначала интегрируйте изменения в stage`;
		}
	}
	if (workdir && !isInsideProject(projectRoot, workdir)) {
		return `рабочая папка ${workdir} выходит за основную папку проекта ${projectRoot}`;
	}
	if (workdir) {
		const worktreeRoot = cachedPrimary(workdir);
		if (!isInsideProject(projectRoot, worktreeRoot)) {
			return `рабочая папка ${workdir} принадлежит другому checkout ${worktreeRoot}`;
		}
	}
	return null;
}

/** Locate a manifest in the primary checkout even when invoked from a linked worktree. */
export function primaryProjectFolder(folder: string): string {
	const primary = primaryCheckout(folder);
	if (existsSync(join(primary, "devhub.json"))) {
		return primary;
	}
	// Preserve a manifest explicitly rooted below a repository without accepting a linked checkout.
	let ancestor = sourcePath(folder);
	while (isInsideProject(primary, ancestor)) {
		if (existsSync(join(ancestor, "devhub.json"))) {
			return ancestor;
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) {
			break;
		}
		ancestor = parent;
	}
	return primary;
}
