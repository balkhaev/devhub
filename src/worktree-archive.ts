import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

const GIT_POINTER = /^gitdir: (.+)\r?\n?$/;
const NULL_CHARACTER = "\0";
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const PROJECT_SEGMENT = /[^a-z0-9-]+/g;
const LINES = /\r?\n/;
const RECORDS = /\r?\n\r?\n/;
const DATE_SEGMENT = /[:.]/g;

export interface ArchiveWorktreeOptions {
	/** Verified active task/process directories. The caller refreshes this list. */
	activePaths?: readonly string[];
	/** Explicit boundary for this cleanup, including legacy root-level worktrees. */
	allowedRoot: string;
	/** One-time cleanup of registered historical .claude/.worktrees folders. */
	allowNestedLegacy?: boolean;
	/** Separate archive directory outside both the project and allowedRoot. */
	archiveRoot: string;
	/** Canonical primary checkout, never a linked checkout. */
	project: string;
	/** Registered linked checkout whose entire contents must be preserved. */
	worktree: string;
}

interface ArchiveSnapshot {
	fingerprint: string;
	head: string;
	index?: Buffer;
	staged: Buffer;
	status: string;
	unstaged: Buffer;
}

function pathKey(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(first: string, second: string): boolean {
	return pathKey(first) === pathKey(second);
}

function inside(root: string, path: string): boolean {
	const child = relative(pathKey(root), pathKey(path));
	return (
		child === "" ||
		!(
			child === ".." ||
			child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(child)
		)
	);
}

/** Inspect existing ancestors too: a junction must not conceal another checkout. */
function plainPath(path: string): void {
	const current = resolve(path);
	const stat = lstatSync(current, { throwIfNoEntry: false });
	if (
		stat &&
		(stat.isSymbolicLink() || !samePath(realpathSync.native(current), current))
	) {
		throw new Error(`Архивация не принимает junction/symlink: ${current}`);
	}
	const parent = dirname(current);
	if (parent !== current) {
		plainPath(parent);
	}
}

function git(project: string, args: string[], worktree?: string): Buffer {
	const result = spawnSync(
		"git",
		worktree
			? ["--git-dir", project, "--work-tree", worktree, ...args]
			: ["-C", project, ...args],
		{
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			maxBuffer: 128 * 1024 * 1024,
			windowsHide: true,
		}
	);
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			result.stderr.toString().trim() || `git ${args[0]}: ${result.status}`
		);
	}
	return result.stdout;
}

function gitText(project: string, args: string[], worktree?: string): string {
	return git(project, args, worktree).toString("utf8").trimEnd();
}

function snapshot(record: string, folder: string): ArchiveSnapshot {
	const head = gitText(record, ["rev-parse", "--verify", "HEAD"], folder);
	const status = git(
		record,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		folder
	).toString("utf8");
	const staged = git(
		record,
		["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--"],
		folder
	);
	const unstaged = git(
		record,
		["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"],
		folder
	);
	const indexPath = join(record, "index");
	const index = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
	const hash = createHash("sha256")
		.update(head)
		.update(status)
		.update(staged)
		.update(unstaged);
	if (index) {
		hash.update(index);
	}
	const untracked = git(
		record,
		["ls-files", "--others", "--exclude-standard", "-z"],
		folder
	)
		.toString("utf8")
		.split(NULL_CHARACTER)
		.filter(Boolean);
	for (const file of untracked) {
		const path = resolve(folder, file);
		if (!inside(folder, path)) {
			throw new Error(`Git вернул путь вне worktree: ${file}`);
		}
		const stat = lstatSync(path);
		hash.update(file).update(String(stat.size)).update(String(stat.mtimeMs));
		if (stat.isSymbolicLink()) {
			hash.update(readlinkSync(path));
		}
	}
	return {
		fingerprint: hash.digest("hex"),
		head,
		index,
		staged,
		status,
		unstaged,
	};
}

function registration(
	project: string,
	worktree: string,
	allowNestedLegacy = false
): { common: string; record: string } {
	const top = gitText(project, ["rev-parse", "--show-toplevel"]);
	const common = resolve(
		gitText(project, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		])
	);
	const primaryGit = resolve(
		gitText(project, ["rev-parse", "--absolute-git-dir"])
	);
	if (!(samePath(top, project) && samePath(primaryGit, common))) {
		throw new Error(`project должен быть основной папкой Git: ${project}`);
	}
	if (
		samePath(worktree, project) ||
		(inside(project, worktree) && !allowNestedLegacy)
	) {
		throw new Error(`Основную папку проекта архивировать нельзя: ${worktree}`);
	}
	const pointer = join(worktree, ".git");
	if (
		!(existsSync(pointer) && lstatSync(pointer).isFile()) ||
		lstatSync(pointer).isSymbolicLink()
	) {
		throw new Error(
			`Ожидается зарегистрированный linked worktree с файлом .git: ${worktree}`
		);
	}
	const match = GIT_POINTER.exec(readFileSync(pointer, "utf8"));
	if (!match?.[1]) {
		throw new Error(`Некорректный указатель .git: ${pointer}`);
	}
	const record = resolve(worktree, match[1]);
	const recordRoot = join(common, "worktrees");
	if (!samePath(dirname(record), recordRoot)) {
		throw new Error(`Worktree принадлежит другому репозиторию: ${worktree}`);
	}
	plainPath(record);
	const backPointer = resolve(
		readFileSync(join(record, "gitdir"), "utf8").trim()
	);
	if (
		!(
			samePath(backPointer, pointer) &&
			samePath(
				resolve(record, readFileSync(join(record, "commondir"), "utf8").trim()),
				common
			)
		)
	) {
		throw new Error(
			`Регистрация worktree не совпадает с проектом: ${worktree}`
		);
	}
	const records = gitText(project, ["worktree", "list", "--porcelain"]).split(
		RECORDS
	);
	const entry = records.find((item) => {
		const [first] = item.split(LINES);
		return (
			first?.startsWith("worktree ") &&
			samePath(first.slice("worktree ".length), worktree)
		);
	});
	if (!entry) {
		throw new Error(`Git не зарегистрировал worktree: ${worktree}`);
	}
	if (
		entry
			.split(LINES)
			.some((line) => line === "locked" || line.startsWith("locked ")) ||
		existsSync(join(record, "index.lock"))
	) {
		throw new Error(`Worktree занят или заблокирован: ${worktree}`);
	}
	return { common, record };
}

/**
 * Preserve an unfinished ordinary worktree as plain files, keeping unique commits
 * in an archive ref. Atomic directory rename preserves ignored/private files and
 * junctions themselves without traversing their destinations. Cross-volume moves
 * are refused so an incomplete copy can never authorize deleting the source.
 */
export function archiveWorktree(options: ArchiveWorktreeOptions): string {
	const project = resolve(options.project);
	const worktree = resolve(options.worktree);
	const allowedRoot = resolve(options.allowedRoot);
	const archiveRoot = resolve(options.archiveRoot);
	for (const path of [project, worktree, allowedRoot, archiveRoot]) {
		plainPath(path);
	}
	if (!inside(allowedRoot, worktree) || samePath(allowedRoot, worktree)) {
		throw new Error(`Worktree вне разрешённой папки: ${worktree}`);
	}
	const { common, record } = registration(
		project,
		worktree,
		options.allowNestedLegacy
	);
	if (
		inside(allowedRoot, archiveRoot) ||
		inside(project, archiveRoot) ||
		inside(worktree, archiveRoot)
	) {
		throw new Error(
			`Архив должен находиться вне проектов и worktree: ${archiveRoot}`
		);
	}
	if (options.activePaths?.some((path) => inside(worktree, resolve(path)))) {
		throw new Error(
			`Worktree используется активной задачей или процессом: ${worktree}`
		);
	}
	const before = snapshot(record, worktree);
	if (!COMMIT.test(before.head)) {
		throw new Error(`Нельзя сохранить HEAD worktree: ${before.head}`);
	}
	const id = `${new Date().toISOString().replaceAll(DATE_SEGMENT, "-")}-${randomUUID()}`;
	const projectName =
		basename(project).toLowerCase().replaceAll(PROJECT_SEGMENT, "-") ||
		"project";
	const archive = join(archiveRoot, projectName, `${basename(worktree)}-${id}`);
	const files = join(archive, "files");
	const archiveRef = `refs/archive/devhub/${projectName}/${id}`;
	mkdirSync(archive, { recursive: true });
	cpSync(record, join(archive, "git-record"), {
		dereference: false,
		recursive: true,
	});
	copyFileSync(join(worktree, ".git"), join(archive, "git-pointer.txt"));
	writeFileSync(join(archive, "staged.patch"), before.staged);
	writeFileSync(join(archive, "unstaged.patch"), before.unstaged);
	if (before.index) {
		writeFileSync(join(archive, "index.bin"), before.index);
	}
	const metadata = {
		archivedAt: new Date().toISOString(),
		archiveRef,
		common,
		fingerprint: before.fingerprint,
		head: before.head,
		project,
		record,
		state: "prepared",
		status: before.status,
		version: 1,
		worktree,
	};
	const writeMetadata = (state: string) =>
		writeFileSync(
			join(archive, "archive.json"),
			`${JSON.stringify({ ...metadata, state }, null, 2)}\n`
		);
	writeMetadata("prepared");
	git(project, [
		"update-ref",
		archiveRef,
		before.head,
		"0".repeat(before.head.length),
	]);
	if (snapshot(record, worktree).fingerprint !== before.fingerprint) {
		writeMetadata("refused-source-changed");
		throw new Error(
			`Worktree изменился во время сохранения; исходная папка сохранена: ${worktree}`
		);
	}
	try {
		renameSync(worktree, files);
	} catch (error) {
		writeMetadata("refused-move");
		throw new Error(
			`Не удалось атомарно переместить worktree; исходная папка сохранена: ${worktree}. Архив должен быть на том же диске. ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	try {
		if (snapshot(record, files).fingerprint !== before.fingerprint) {
			throw new Error("Исходники изменились во время перемещения");
		}
		if (
			!(
				samePath(
					resolve(readFileSync(join(record, "gitdir"), "utf8").trim()),
					join(worktree, ".git")
				) && samePath(dirname(record), join(common, "worktrees"))
			)
		) {
			throw new Error("Регистрация изменилась во время перемещения");
		}
	} catch (error) {
		if (!existsSync(worktree)) {
			renameSync(files, worktree);
		}
		writeMetadata("refused-after-move");
		throw new Error(
			`Проверка перемещённого worktree не прошла; работа и Git metadata сохранены: ${archive}`,
			{ cause: error }
		);
	}
	// Git removes this now-missing path's registration without force or global pruning.
	// Its pointer and private Git record were copied above; other records stay untouched.
	unlinkSync(join(files, ".git"));
	git(project, ["worktree", "remove", worktree]);
	if (existsSync(record)) {
		writeMetadata("registration-removal-incomplete");
		throw new Error(
			`Git оставил регистрацию worktree; файлы сохранены: ${archive}`
		);
	}
	writeMetadata("archived");
	return archive;
}
