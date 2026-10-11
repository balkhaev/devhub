import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

import { isInsideProject, primaryCheckout, sameSourcePath } from "./checkouts";
import { canonicalProjectFolder, loadCatalogue } from "./config";
import { acquireFileLock, type ProcessProbe, systemProbe } from "./stage-lock";
import {
	type ProjectMode,
	type WorkflowPolicy,
	withProjectModeText,
	workflowPolicySchema,
} from "./workflow-policy";

const ROOT = primaryCheckout(resolve(import.meta.dir, ".."));
const POLICY = join(".devhub", "worktree.json");
const TOPIC_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const CODEX_PREFIX = /^codex\//;
const BRANCH_PREFIX = /^refs\/heads\//;
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;
const DAY_SECONDS = 86_400;
/** Ignored folders any checkout rebuilds from its lockfile or by running its tools. */
const REBUILDABLE = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".ruff_cache",
	".mypy_cache",
	".next",
	".turbo",
	".cache",
	".parcel-cache",
	".svelte-kit",
	".nuxt",
	".vite",
]);
const REBUILDABLE_SUFFIXES = [".egg-info", ".tsbuildinfo", ".pyc"];
const PRIVATE_SAMPLE = 5;

const rebuildable = (segment: string): boolean =>
	REBUILDABLE.has(segment) ||
	REBUILDABLE_SUFFIXES.some((suffix) => segment.endsWith(suffix));

interface CheckRecord {
	checkedAt: string;
	checks: string[];
	fingerprint: string;
	head: string | null;
}

export interface WorktreeRecord {
	branch?: string;
	head?: string;
	locked?: string;
	path: string;
}

/** Everything a project keeps beyond its clean canonical checkout. */
export interface TidyReport {
	/** Uncommitted paths in the canonical folder. */
	canonicalChanges: number;
	/** Closed branches without commits of their own: `tidyApply` deletes them. */
	merged: { branch: string; head: string }[];
	/** Registered worktrees whose folder is gone: `tidyApply` prunes them. */
	missing: string[];
	/** Closed branches that still hold commits outside the integration branch. */
	parked: { ahead: number; branch: string; days: number }[];
	root: string;
	stashes: number;
	/** Folders in the policy's `worktreeRoot` that are not a worktree of this project. */
	unregistered: string[];
	working: {
		ahead: number;
		behind: number;
		branch?: string;
		changes: number;
		/** Days since the last commit of the checkout. */
		days: number;
		/** Outside the policy's `worktreeRoot`. */
		outside: boolean;
		path: string;
	}[];
}

const HELP = `DevHub: MVP → main + push + выпуск; Прод → stage → проверка → отдельный выпуск
  bun run stage init --project PATH           выделить stage, сохранив локальные правки
  bun run stage create TOPIC --project PATH   временный codex/TOPIC от основной ветки режима
  bun run stage integrate REF --project PATH  влить и проверить; MVP сразу push + выпуск
  bun run stage publish --project PATH        проверить и опубликовать текущий main в MVP
  bun run stage mode mvp|prod --project PATH   выбрать режим и основную ветку
  bun run stage check --project PATH          выполнить проверки из .devhub/worktree.json
  bun run stage status --project PATH         stage, worktree, актуальность проверки
  bun run stage finish PATH --project PATH    убрать чистый, уже влитый worktree и его ветку
  bun run stage close PATH --project PATH     закрыть чистый worktree, сохранив его ветку
  bun run stage tidy [--apply] --project PATH что осталось после задач; --apply убирает слитые
                                              ветки и записи о worktree без папок

В проекте те же команды доступны через bun/npm run worktree.
DevHub запускает dev только из основной папки. В Прод push/deploy требуют отдельного выпуска.
`;

/** Git operations use argument arrays; paths and refs never become shell code. */
export function gitOutput(
	root: string,
	args: string[],
	optional = false
): string {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0 && !optional) {
		throw new Error(result.stderr.trim() || `git ${args[0]}: ${result.status}`);
	}
	return result.status === 0 ? result.stdout.trimEnd() : "";
}

export class StageProject {
	readonly root: string;
	readonly policy: WorkflowPolicy;
	readonly worktreeRoot: string;
	readonly stateFile: string;
	readonly lockFile: string;

	constructor(folder: string, stateRoot = join(ROOT, ".state", "stage")) {
		this.root = primaryCheckout(folder);
		this.policy = workflowPolicySchema.parse(
			JSON.parse(readFileSync(join(this.root, POLICY), "utf8"))
		);
		this.worktreeRoot = resolve(this.root, this.policy.worktreeRoot);
		if (isInsideProject(this.root, this.worktreeRoot)) {
			throw new Error(
				"worktreeRoot должен находиться вне основной папки проекта"
			);
		}
		mkdirSync(stateRoot, { recursive: true });
		const key = createHash("sha256")
			.update(
				process.platform === "win32" ? this.root.toLowerCase() : this.root
			)
			.digest("hex");
		this.stateFile = join(stateRoot, `${key}.json`);
		// Check records may live in a caller's temporary state folder; ownership locks are machine-wide.
		const lockRoot = join(ROOT, ".state", "stage");
		mkdirSync(lockRoot, { recursive: true });
		this.lockFile = join(lockRoot, `${key}.lock`);
	}

	branch(): string {
		return gitOutput(this.root, ["symbolic-ref", "--short", "HEAD"], true);
	}

	head(): string | null {
		return (
			gitOutput(this.root, ["rev-parse", "--verify", "HEAD"], true) || null
		);
	}

	get integrationBranch(): string {
		return this.policy.mode === "mvp"
			? this.policy.releaseBranch
			: this.policy.stageBranch;
	}

	private assertStage(): void {
		if (this.branch() !== this.integrationBranch) {
			throw new Error(
				`${this.root}: основная папка должна быть на ветке ${this.integrationBranch}`
			);
		}
	}

	private assertClean(folder = this.root): void {
		if (gitOutput(folder, ["status", "--porcelain", "--untracked-files=all"])) {
			throw new Error(
				`${folder}: есть локальные изменения; сохраните их в рабочей ветке перед интеграцией`
			);
		}
		if (gitOutput(folder, ["rev-parse", "--verify", "MERGE_HEAD"], true)) {
			throw new Error(`${folder}: сначала завершите текущий merge`);
		}
	}

	/** Same-HEAD branch creation preserves the index and all working files, even in an unborn repo. */
	init(): void {
		if (this.branch() === this.integrationBranch) {
			return;
		}
		const current = this.head();
		const stage = gitOutput(
			this.root,
			["rev-parse", "--verify", `refs/heads/${this.integrationBranch}`],
			true
		);
		if (!current) {
			if (stage) {
				throw new Error(
					"в репозитории без HEAD уже есть stage; сначала проверьте существующую ветку"
				);
			}
			gitOutput(this.root, [
				"symbolic-ref",
				"HEAD",
				`refs/heads/${this.integrationBranch}`,
			]);
		} else if (!stage) {
			gitOutput(this.root, ["switch", "-c", this.integrationBranch]);
		} else if (stage === current) {
			gitOutput(this.root, ["switch", this.integrationBranch]);
		} else {
			throw new Error(
				`${this.root}: ${this.integrationBranch} уже существует на другом коммите; автоматический перенос локальных правок запрещён`
			);
		}
	}

	/** Same-tree branch transitions preserve the index, private files and concurrent working edits. */
	setMode(mode: ProjectMode, options: { commit?: boolean } = {}): void {
		const policyHadEdits = Boolean(
			gitOutput(this.root, ["diff", "HEAD", "--", POLICY], true)
		);
		const fresh = workflowPolicySchema.parse(
			JSON.parse(readFileSync(join(this.root, POLICY), "utf8"))
		);
		if (JSON.stringify(fresh) !== JSON.stringify(this.policy)) {
			throw new Error(
				"политика проекта изменилась; перечитайте её перед сменой режима"
			);
		}
		if (gitOutput(this.root, ["rev-parse", "--verify", "MERGE_HEAD"], true)) {
			throw new Error("сначала завершите текущий merge");
		}
		const branch =
			mode === "mvp" ? this.policy.releaseBranch : this.policy.stageBranch;
		const head = this.head();
		const ref = `refs/heads/${branch}`;
		const target = gitOutput(this.root, ["rev-parse", "--verify", ref], true);
		const other = this.worktrees().find(
			(item) => item.branch === branch && !sameSourcePath(item.path, this.root)
		);
		if (other) {
			throw new Error(
				`${branch} уже используется в ${other.path}; сначала завершите worktree`
			);
		}
		if (head && target && target !== head) {
			const ancestor = spawnSync(
				"git",
				["-C", this.root, "merge-base", "--is-ancestor", target, head],
				{ windowsHide: true }
			);
			if (ancestor.status !== 0) {
				throw new Error(
					`${branch} содержит другую историю; автоматическая смена режима запрещена`
				);
			}
		}
		if (head && target !== head) {
			gitOutput(this.root, [
				"update-ref",
				ref,
				head,
				target || "0000000000000000000000000000000000000000",
			]);
		}
		if (head) {
			gitOutput(this.root, ["switch", branch]);
		} else {
			gitOutput(this.root, ["symbolic-ref", "HEAD", ref]);
		}
		this.policy.mode = mode;
		const file = join(this.root, POLICY);
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(
			temporary,
			withProjectModeText(readFileSync(file, "utf8"), mode)
		);
		renameSync(temporary, file);
		// A UI mode change must not leave its own configuration blocking the next task.
		// Existing policy edits belong to their author and are never swept into this commit.
		if (
			options.commit !== false &&
			head &&
			!policyHadEdits &&
			gitOutput(this.root, ["diff", "HEAD", "--name-only", "--", POLICY])
		) {
			gitOutput(this.root, ["add", "--", POLICY]);
			gitOutput(this.root, [
				"commit",
				"--only",
				"-m",
				`Set project mode to ${mode}`,
				"--",
				POLICY,
			]);
		}
		rmSync(this.stateFile, { force: true });
	}

	create(topic: string): string {
		this.assertStage();
		if (this.policy.mode === "prod") {
			this.assertClean();
		}
		const name = topic.replace(CODEX_PREFIX, "");
		if (!name.split("/").every((part) => TOPIC_SEGMENT.test(part))) {
			throw new Error(
				"имя задачи: строчные буквы, цифры, дефисы, допустим разделитель /"
			);
		}
		const folder = resolve(this.worktreeRoot, name);
		if (!isInsideProject(this.worktreeRoot, folder)) {
			throw new Error(`путь worktree недоступен: ${folder}`);
		}
		const branch = `codex/${name}`;
		const existing = this.worktrees().find((item) =>
			sameSourcePath(item.path, folder)
		);
		if (
			existing?.branch === branch &&
			existing.locked !== "initializing" &&
			existsSync(folder)
		) {
			return folder;
		}
		if (existing || existsSync(folder) || this.branchHead(branch)) {
			this.recoverInterruptedCreate(branch, folder, existing);
		}
		gitOutput(this.root, [
			"worktree",
			"add",
			"-b",
			branch,
			folder,
			`refs/heads/${this.integrationBranch}`,
		]);
		return folder;
	}

	private branchHead(branch: string): string {
		return gitOutput(
			this.root,
			["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
			true
		);
	}

	/**
	 * A killed `create` leaves a half checked-out folder, its Git registration (locked as
	 * "initializing", or already gone) and a codex branch without commits. They are removed only
	 * when the branch adds nothing to the integration branch and every file in the folder is
	 * the unchanged committed version; anything else is reported and kept.
	 */
	private recoverInterruptedCreate(
		branch: string,
		folder: string,
		registered?: WorktreeRecord
	): void {
		const keep = (reason: string) =>
			new Error(
				`${folder}: ${reason}; прерванный create остаётся рабочим — сохраните правки или выберите другое имя задачи`
			);
		if (registered && registered.branch !== branch) {
			throw new Error(`путь worktree недоступен: ${folder}`);
		}
		const common = gitOutput(this.root, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		const present = existsSync(folder);
		const filled = present && readdirSync(folder).length > 0;
		if (filled && !registered) {
			this.assertOrphanedCheckout(folder, common);
		}
		const head = this.branchHead(branch);
		if (head) {
			this.assertEmptyTaskBranch(branch, folder, keep);
		}
		if (filled) {
			const base =
				registered?.head ||
				head ||
				gitOutput(this.root, [
					"rev-parse",
					"--verify",
					`refs/heads/${this.integrationBranch}`,
				]);
			const changed = this.changedAgainst(common, folder, base);
			if (changed.length) {
				throw keep(
					`в папке есть файлы, отличные от ${base.slice(0, 12)}: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""}`
				);
			}
		}
		if (registered) {
			// Removes exactly this entry, including the "initializing" lock, and its folder.
			gitOutput(this.root, [
				"worktree",
				"remove",
				"--force",
				"--force",
				folder,
			]);
		} else if (present) {
			rmSync(folder, { force: true, maxRetries: 3, recursive: true });
		}
		if (head) {
			// Compare-and-delete: a branch that moved in the meantime is kept.
			gitOutput(this.root, ["update-ref", "-d", `refs/heads/${branch}`, head]);
		}
		process.stderr.write(
			`stage: очищен прерванный create ${branch}: ${folder}\n`
		);
	}

	/** Only a checkout whose Git registration is gone counts as left over by create. */
	private assertOrphanedCheckout(folder: string, common: string): void {
		const marker = join(folder, ".git");
		const gitdir =
			existsSync(marker) && statSync(marker).isFile()
				? GITDIR_LINE.exec(readFileSync(marker, "utf8"))?.[1]
				: undefined;
		const admin = gitdir ? resolve(folder, gitdir) : undefined;
		if (
			!(
				admin &&
				isInsideProject(join(common, "worktrees"), admin) &&
				!existsSync(admin)
			)
		) {
			throw new Error(`путь worktree недоступен: ${folder}`);
		}
	}

	/** A task branch may be replaced only while nothing uses it and it adds no commits. */
	private assertEmptyTaskBranch(
		branch: string,
		folder: string,
		keep: (reason: string) => Error
	): void {
		const user = this.worktrees().find(
			(item) => item.branch === branch && !sameSourcePath(item.path, folder)
		);
		if (user) {
			throw keep(`ветка ${branch} используется в ${user.path}`);
		}
		const ahead = gitOutput(this.root, [
			"rev-list",
			"--count",
			`refs/heads/${this.integrationBranch}..refs/heads/${branch}`,
		]);
		if (ahead !== "0") {
			throw keep(
				`ветка ${branch} содержит коммиты вне ${this.integrationBranch} (${ahead})`
			);
		}
	}

	/** Paths in a folder that are not the committed version; files missing from it do not count. */
	private changedAgainst(
		common: string,
		folder: string,
		commit: string
	): string[] {
		const scratch = mkdtempSync(join(tmpdir(), "devhub-stage-index-"));
		const run = (args: string[]) => {
			const result = spawnSync(
				"git",
				[
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.untrackedCache=false",
					`--git-dir=${common}`,
					`--work-tree=${folder}`,
					...args,
				],
				{
					cwd: folder,
					encoding: "utf8",
					env: { ...process.env, GIT_INDEX_FILE: join(scratch, "index") },
					maxBuffer: 32 * 1024 * 1024,
					windowsHide: true,
				}
			);
			if (result.error) {
				throw result.error;
			}
			if (result.status !== 0) {
				throw new Error(
					result.stderr.trim() || `git ${args[0]}: ${result.status}`
				);
			}
			return result.stdout;
		};
		try {
			run(["read-tree", commit]);
			return (
				run([
					"status",
					"--porcelain",
					"-z",
					"--no-renames",
					"--untracked-files=all",
					"--ignored",
				])
					.split("\0")
					// The first column compares with the repository HEAD, not with this commit; a
					// missing file (D) is only an unfinished checkout.
					.filter(
						(entry) =>
							entry.startsWith("??") ||
							entry.startsWith("!!") ||
							!" D".includes(entry[1] ?? " ")
					)
					.map((entry) => entry.slice(3))
			);
		} finally {
			rmSync(scratch, { force: true, recursive: true });
		}
	}

	worktrees(): WorktreeRecord[] {
		const tokens = gitOutput(this.root, [
			"worktree",
			"list",
			"--porcelain",
			"-z",
		]).split("\0");
		const result: WorktreeRecord[] = [];
		let current: WorktreeRecord | undefined;
		for (const token of tokens) {
			if (token.startsWith("worktree ")) {
				current = { path: token.slice(9) };
				result.push(current);
			} else if (current && token.startsWith("HEAD ")) {
				current.head = token.slice(5);
			} else if (current && token.startsWith("branch refs/heads/")) {
				current.branch = token.slice(18);
			} else if (
				current &&
				(token === "locked" || token.startsWith("locked "))
			) {
				current.locked = token.slice(7);
			}
		}
		return result;
	}

	private resolveSource(source: string): string {
		const path = resolve(source);
		if (existsSync(path)) {
			const worktree = this.worktrees().find((item) =>
				sameSourcePath(item.path, path)
			);
			if (!worktree || sameSourcePath(this.root, path)) {
				throw new Error(`${path}: нужен worktree этого проекта`);
			}
			this.assertClean(path);
			return gitOutput(path, ["rev-parse", "--verify", "HEAD"]);
		}
		const commit = gitOutput(this.root, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${source}^{commit}`,
		]);
		// A branch may still have uncommitted work in its checkout; never silently omit it.
		const branch = source.replace(BRANCH_PREFIX, "");
		for (const worktree of this.worktrees()) {
			if (worktree.branch === branch && existsSync(worktree.path)) {
				this.assertClean(worktree.path);
			}
		}
		return commit;
	}

	integrate(source: string): void {
		this.assertStage();
		if (this.policy.mode === "prod") {
			this.assertClean();
		}
		if (
			gitOutput(this.root, ["diff", "--cached", "--name-only"]) ||
			gitOutput(this.root, ["rev-parse", "--verify", "MERGE_HEAD"], true)
		) {
			throw new Error(
				"индекс основной папки занят; сохраните staged-правки или завершите merge"
			);
		}
		const commit = this.resolveSource(source);
		const sourcePath = resolve(source);
		const sourceTree = this.worktrees().find(
			(item) =>
				sameSourcePath(item.path, sourcePath) ||
				item.branch === source.replace(BRANCH_PREFIX, "")
		);
		if (this.policy.mode === "mvp" && this.status().dirty && !sourceTree) {
			throw new Error(
				"для MVP с посторонними правками нужен чистый worktree задачи: он проверит точный main перед push"
			);
		}
		// A failed merge remains visible in stage for conflict resolution; nothing is reset or pushed.
		gitOutput(this.root, ["merge", "--no-ff", "--no-edit", commit]);
		this.check();
		if (this.policy.mode === "mvp") {
			const tree =
				this.status().dirty && sourceTree
					? this.verifyCommittedCheckout(sourceTree.path, commit)
					: undefined;
			this.publishChecked(tree, tree ? sourceTree?.path : undefined);
			if (
				sourceTree &&
				isInsideProject(this.worktreeRoot, sourceTree.path) &&
				!sameSourcePath(this.worktreeRoot, sourceTree.path)
			) {
				this.finish(sourceTree.path);
			}
		}
	}

	private verifyCommittedCheckout(folder: string, expected: string): string {
		this.assertClean(folder);
		if (gitOutput(folder, ["rev-parse", "HEAD"]) !== expected) {
			throw new Error(
				"worktree задачи изменился во время интеграции; push отменён"
			);
		}
		const head = this.head();
		if (!head) {
			throw new Error("main не содержит коммит");
		}
		gitOutput(folder, ["switch", "--detach", head]);
		const before = this.fingerprint();
		this.runChecks(folder);
		this.assertClean(folder);
		if (
			before !== this.fingerprint() ||
			gitOutput(folder, ["rev-parse", "HEAD"]) !== head
		) {
			throw new Error(
				"исходники изменились во время проверки main; push отменён"
			);
		}
		return gitOutput(folder, ["rev-parse", "HEAD^{tree}"]);
	}

	/** MVP publication never force-pushes and never includes uncommitted edits. */
	private publishChecked(verifiedTree?: string, verifiedFolder?: string): void {
		this.assertStage();
		const status = this.status();
		const exactTree =
			verifiedTree &&
			verifiedTree === gitOutput(this.root, ["rev-parse", "HEAD^{tree}"]);
		if (
			this.policy.mode !== "mvp" ||
			!status.checked ||
			(status.dirty && !exactTree)
		) {
			throw new Error(
				"автоматический выпуск доступен только после финальной проверки MVP"
			);
		}
		if (this.policy.remote === null) {
			console.log(`MVP сохранён в локальном ${this.policy.releaseBranch}`);
			return;
		}
		if (
			!gitOutput(this.root, ["remote", "get-url", this.policy.remote], true)
		) {
			throw new Error(
				`не настроен Git remote ${this.policy.remote}; main проверен, но не опубликован`
			);
		}
		gitOutput(this.root, [
			"push",
			this.policy.remote,
			`refs/heads/${this.policy.releaseBranch}:refs/heads/${this.policy.releaseBranch}`,
		]);
		if (this.policy.deploy) {
			const deployEnv: Record<string, string | undefined> = {
				...process.env,
				NODE_ENV: "production",
			};
			// New local integrations must never become inherited release configuration.
			for (const key of Object.keys(deployEnv)) {
				if (key.toUpperCase().startsWith("DEVHUB_")) {
					delete deployEnv[key];
				}
			}
			const result = spawnSync(this.policy.deploy, {
				cwd: verifiedFolder ?? this.root,
				env: deployEnv,
				shell: true,
				stdio: "inherit",
				windowsHide: true,
			});
			if (result.error) {
				throw result.error;
			}
			if (result.status !== 0) {
				throw new Error(
					`main опубликован; production-команда завершилась с exit ${result.status}`
				);
			}
		}
	}

	publish(): void {
		if (this.policy.mode !== "mvp") {
			throw new Error(
				"в режиме Прод выпуск выполняется отдельно после проверки stage"
			);
		}
		this.assertClean();
		this.check();
		this.publishChecked();
	}

	private fingerprint(): string {
		const digest = createHash("sha256");
		digest.update(
			JSON.stringify({
				branch: this.branch(),
				checks: this.policy.checks,
				head: this.head(),
				mode: this.policy.mode,
			})
		);
		digest.update(
			gitOutput(this.root, ["diff", "--binary", "HEAD"], !this.head())
		);
		digest.update(gitOutput(this.root, ["diff", "--cached", "--binary"]));
		const files = gitOutput(this.root, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		])
			.split("\0")
			.filter(Boolean)
			.sort();
		for (const file of files) {
			digest.update(file);
			digest.update(readFileSync(join(this.root, file)));
		}
		// Local runtime configuration affects the final app even when intentionally ignored by Git.
		const folders = [this.root, join(this.root, ".montage")];
		const apps = join(this.root, "apps");
		if (existsSync(apps)) {
			for (const entry of readdirSync(apps, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					folders.push(join(apps, entry.name));
				}
			}
		}
		for (const folder of folders) {
			for (const name of [
				".env",
				".env.local",
				".env.development",
				".env.development.local",
				"config.env",
			]) {
				const file = join(folder, name);
				if (existsSync(file)) {
					digest.update(file);
					digest.update(readFileSync(file));
				}
			}
		}
		return digest.digest("hex");
	}

	check(): void {
		this.assertStage();
		if (!this.policy.checks.length) {
			throw new Error(`${this.root}: задайте финальные checks в ${POLICY}`);
		}
		// Invalidate a previous successful run before starting, including on interruption.
		rmSync(this.stateFile, { force: true });
		const before = this.fingerprint();
		this.runChecks(this.root);
		const after = this.fingerprint();
		if (before !== after) {
			throw new Error(
				"проверки изменили исходники; проверьте изменения и запустите check повторно"
			);
		}
		writeFileSync(
			this.stateFile,
			`${JSON.stringify({ checkedAt: new Date().toISOString(), checks: this.policy.checks, fingerprint: after, head: this.head() } satisfies CheckRecord, null, 2)}\n`
		);
	}

	private runChecks(folder: string): void {
		for (const command of this.policy.checks) {
			process.stdout.write(`check: ${folder} · ${command}\n`);
			const result = spawnSync(command, {
				cwd: folder,
				env: { ...process.env, DEVHUB_STAGE: "1" },
				shell: true,
				stdio: "inherit",
				windowsHide: true,
			});
			if (result.error) {
				throw result.error;
			}
			if (result.status !== 0) {
				throw new Error(
					`финальная проверка не прошла: ${command} (exit ${result.status})`
				);
			}
		}
	}

	status() {
		let record: CheckRecord | undefined;
		if (existsSync(this.stateFile)) {
			record = JSON.parse(readFileSync(this.stateFile, "utf8")) as CheckRecord;
		}
		const dirty = Boolean(
			gitOutput(this.root, ["status", "--porcelain", "--untracked-files=all"])
		);
		const checked = Boolean(
			record && record.fingerprint === this.fingerprint()
		);
		return {
			branch: this.branch(),
			checked,
			checkedAt: checked ? record?.checkedAt : undefined,
			dirty,
			head: this.head(),
			integrationBranch: this.integrationBranch,
			mode: this.policy.mode,
			releaseBranch: this.policy.releaseBranch,
			releaseReady:
				checked && !dirty && this.branch() === this.integrationBranch,
			root: this.root,
			worktrees: this.worktrees(),
		};
	}

	finish(folder: string): string {
		this.assertStage();
		if (this.policy.mode === "prod") {
			this.assertClean();
		}
		if (!this.status().checked) {
			throw new Error("сначала успешно проверьте текущий чистый stage");
		}
		const path = resolve(folder);
		const worktree = this.worktrees().find((item) =>
			sameSourcePath(item.path, path)
		);
		if (
			!(worktree?.head && isInsideProject(this.worktreeRoot, path)) ||
			sameSourcePath(path, this.worktreeRoot)
		) {
			throw new Error(
				`${path}: удаление допустимо только для worktree внутри ${this.worktreeRoot}`
			);
		}
		this.assertClean(path);
		gitOutput(this.root, [
			"merge-base",
			"--is-ancestor",
			worktree.head,
			`refs/heads/${this.integrationBranch}`,
		]);
		return this.closeWorktree(path, true);
	}

	/** Close a committed task without deleting its branch or producing an archive. */
	close(folder: string): string {
		return this.closeWorktree(folder, false);
	}

	private closeWorktree(folder: string, integrated: boolean): string {
		this.assertStage();
		const path = resolve(folder);
		const worktree = this.worktrees().find((item) =>
			sameSourcePath(item.path, path)
		);
		if (
			!(worktree?.head && isInsideProject(this.worktreeRoot, path)) ||
			sameSourcePath(path, this.worktreeRoot)
		) {
			throw new Error(
				`${path}: закрытие допустимо только для worktree внутри ${this.worktreeRoot}`
			);
		}
		this.assertClean(path);
		const kept = this.privateIgnored(path);
		if (kept.length) {
			throw new Error(
				`${path}: приватные ignored-файлы нужно сохранить до закрытия (${kept.join(", ")}${kept.length === PRIVATE_SAMPLE ? ", …" : ""}); worktree остаётся рабочим`
			);
		}
		if (!(worktree.branch || integrated)) {
			throw new Error(
				`${path}: сначала сохраните HEAD в ветке; worktree остаётся рабочим`
			);
		}
		// Git verifies registration, locks and cleanliness again; never force removal.
		gitOutput(this.root, ["worktree", "remove", path]);
		// An integrated task leaves nothing behind: its commits are in the integration branch.
		const dropped =
			integrated && worktree.branch && worktree.head
				? this.deleteMergedBranch(worktree.branch, worktree.head)
				: false;
		let outcome = "интегрированные коммиты сохранены";
		if (dropped) {
			outcome = `ветка ${worktree.branch} удалена: её коммиты в ${this.integrationBranch}`;
		} else if (worktree.branch) {
			outcome = `ветка ${worktree.branch} сохранена`;
		}
		process.stdout.write(`worktree закрыт; ${outcome}\n`);
		return path;
	}

	/** Ignored files that are not inside a rebuildable folder; the first few are enough to refuse. */
	private privateIgnored(folder: string): string[] {
		const found: string[] = [];
		const visit = (entry: string) => {
			if (
				found.length >= PRIVATE_SAMPLE ||
				entry.split("/").some(rebuildable)
			) {
				return;
			}
			if (!entry.endsWith("/")) {
				found.push(entry);
				return;
			}
			// Git names only the outermost ignored folder; its own layout decides what it holds.
			for (const item of readdirSync(join(folder, entry), {
				withFileTypes: true,
			})) {
				visit(`${entry}${item.name}${item.isDirectory() ? "/" : ""}`);
			}
		};
		for (const entry of gitOutput(folder, [
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			// One entry per wholly ignored folder: a dependency tree is not listed file by file.
			"--directory",
			"-z",
		])
			.split("\0")
			.filter(Boolean)) {
			visit(entry);
		}
		return found;
	}

	private protectedBranch(branch: string): boolean {
		return [
			this.integrationBranch,
			this.policy.releaseBranch,
			this.policy.stageBranch,
		].includes(branch);
	}

	/** Compare-and-delete: a branch that moved, is checked out or adds commits is kept. */
	private deleteMergedBranch(branch: string, head: string): boolean {
		if (
			this.protectedBranch(branch) ||
			this.worktrees().some((item) => item.branch === branch)
		) {
			return false;
		}
		const contained = spawnSync(
			"git",
			[
				"-C",
				this.root,
				"merge-base",
				"--is-ancestor",
				head,
				`refs/heads/${this.integrationBranch}`,
			],
			{ windowsHide: true }
		);
		if (contained.status !== 0) {
			return false;
		}
		const removed = spawnSync(
			"git",
			["-C", this.root, "update-ref", "-d", `refs/heads/${branch}`, head],
			{ windowsHide: true }
		);
		if (removed.status !== 0) {
			return false;
		}
		// The upstream and merge settings of a deleted branch name nothing.
		gitOutput(
			this.root,
			["config", "--remove-section", `branch.${branch}`],
			true
		);
		return true;
	}

	/** What the project still keeps after its tasks; reads Git only. */
	tidy(): TidyReport {
		const integration = `refs/heads/${this.integrationBranch}`;
		const now = Date.now() / 1000;
		const days = (seconds: string) =>
			Math.max(0, Math.floor((now - Number(seconds)) / DAY_SECONDS));
		const count = (range: string, folder = this.root) =>
			Number(gitOutput(folder, ["rev-list", "--count", range], true) || 0);
		const changes = (folder: string) =>
			gitOutput(folder, ["status", "--porcelain", "--untracked-files=all"])
				.split("\n")
				.filter(Boolean).length;
		const records = this.worktrees().filter(
			(item) => !sameSourcePath(item.path, this.root)
		);
		const present = records.filter((item) => existsSync(item.path));
		// A registration without a folder still reserves its branch until it is pruned.
		const held = new Set(records.map((item) => item.branch).filter(Boolean));
		const merged = new Set(
			gitOutput(this.root, [
				"for-each-ref",
				"refs/heads",
				`--merged=${integration}`,
				"--format=%(refname:short)",
			])
				.split("\n")
				.filter(Boolean)
		);
		const report: TidyReport = {
			canonicalChanges: changes(this.root),
			merged: [],
			missing: records
				.filter((item) => !existsSync(item.path))
				.map((item) => item.path),
			parked: [],
			root: this.root,
			stashes: gitOutput(this.root, ["stash", "list"], true)
				.split("\n")
				.filter(Boolean).length,
			unregistered: (existsSync(this.worktreeRoot)
				? readdirSync(this.worktreeRoot, { withFileTypes: true })
				: []
			)
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(this.worktreeRoot, entry.name))
				// A task named `area/topic` keeps its checkout one level deeper.
				.filter(
					(folder) =>
						!present.some((item) => isInsideProject(folder, item.path))
				),
			working: present.map((item) => ({
				ahead: count(`${integration}..HEAD`, item.path),
				behind: count(`HEAD..${integration}`, item.path),
				branch: item.branch,
				changes: changes(item.path),
				days: days(gitOutput(item.path, ["log", "-1", "--format=%ct"], true)),
				outside: !isInsideProject(this.worktreeRoot, item.path),
				path: item.path,
			})),
		};
		for (const line of gitOutput(this.root, [
			"for-each-ref",
			"refs/heads",
			"--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)",
		])
			.split("\n")
			.filter(Boolean)) {
			const [branch = "", head = "", committed = "0"] = line.split("\t");
			if (this.protectedBranch(branch) || held.has(branch)) {
				continue;
			}
			if (merged.has(branch)) {
				report.merged.push({ branch, head });
			} else {
				report.parked.push({
					ahead: count(`${integration}..refs/heads/${branch}`),
					branch,
					days: days(committed),
				});
			}
		}
		return report;
	}

	/** Remove only what holds nothing: registrations without a folder and merged closed branches. */
	tidyApply(): { branches: string[]; pruned: string[] } {
		const before = this.tidy();
		// A registration on an unplugged drive is not an abandoned one.
		const reachable = before.missing.every((path) =>
			existsSync(parse(resolve(path)).root)
		);
		if (before.missing.length && reachable) {
			gitOutput(this.root, ["worktree", "prune"]);
		}
		const after = this.tidy();
		return {
			branches: after.merged
				.filter((item) => this.deleteMergedBranch(item.branch, item.head))
				.map((item) => item.branch),
			pruned: before.missing.filter((path) => !after.missing.includes(path)),
		};
	}

	/**
	 * Shared by synchronous Git operations and the asynchronous filesystem deletion lifecycle.
	 * A lock left by a killed process is replaced only after its holder is provably gone.
	 */
	acquireLock(probe: ProcessProbe = systemProbe): () => void {
		return acquireFileLock(
			this.lockFile,
			"проект занят другим stage-процессом",
			probe
		);
	}

	withLock<T>(action: () => T): T {
		const release = this.acquireLock();
		try {
			return action();
		} finally {
			release();
		}
	}
}

function parseArgs(args: string[]) {
	const action = args[0] ?? "help";
	let apply = false;
	let project: string | undefined;
	const operands: string[] = [];
	for (let i = 1; i < args.length; i += 1) {
		const value = args[i] ?? "";
		if (value === "--project") {
			i += 1;
			project = args[i];
			if (!project || project.startsWith("--")) {
				throw new Error("после --project нужен путь или id проекта");
			}
		} else if (value === "--apply" && action === "tidy") {
			apply = true;
		} else if (value.startsWith("-")) {
			throw new Error(`неизвестный параметр ${value}`);
		} else {
			operands.push(value);
		}
	}
	return { action, apply, operands, project };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const { action, apply, operands, project } = parseArgs(args);
	if (["help", "--help", "-h"].includes(action)) {
		process.stdout.write(HELP);
		return;
	}
	const takesOperand = [
		"create",
		"integrate",
		"finish",
		"close",
		"mode",
	].includes(action);
	if (
		![
			"init",
			"create",
			"integrate",
			"check",
			"status",
			"finish",
			"close",
			"publish",
			"mode",
			"tidy",
		].includes(action) ||
		operands.length !== (takesOperand ? 1 : 0)
	) {
		throw new Error(`неверная команда\n${HELP}`);
	}
	let folder = project ?? process.cwd();
	if (project && !isAbsolute(project) && !existsSync(project)) {
		const catalogue = await loadCatalogue(join(ROOT, "services.json"));
		const known = catalogue.projects.find((item) => item.id === project);
		if (!known) {
			throw new Error(`неизвестный проект ${project}`);
		}
		folder = known.path;
	}
	// Machine aliases also route worktree commands from retired independent copies.
	const catalogue = await loadCatalogue(join(ROOT, "services.json"));
	folder = canonicalProjectFolder(catalogue, folder);
	const stage = new StageProject(folder);
	if (action === "status") {
		process.stdout.write(`${JSON.stringify(stage.status(), null, 2)}\n`);
		return;
	}
	if (action === "tidy") {
		const applied = apply ? stage.withLock(() => stage.tidyApply()) : undefined;
		process.stdout.write(
			`${JSON.stringify({ ...(applied ? { applied } : {}), ...stage.tidy() }, null, 2)}\n`
		);
		return;
	}
	const [operand = ""] = operands;
	stage.withLock(() => {
		if (action === "init") {
			stage.init();
		} else if (action === "create") {
			process.stdout.write(`${stage.create(operand)}\n`);
		} else if (action === "integrate") {
			stage.integrate(operand);
		} else if (action === "check") {
			stage.check();
		} else if (action === "finish") {
			stage.finish(operand);
		} else if (action === "close") {
			stage.close(operand);
		} else if (action === "publish") {
			stage.publish();
		} else if (action === "mode") {
			const mode = operand;
			if (mode !== "mvp" && mode !== "prod") {
				throw new Error("режим: mvp или prod");
			}
			stage.setMode(mode);
		}
	});
	process.stdout.write(`${stage.root}: ${action} — готово\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`devhub stage: ${(error as Error).message}\n`);
		process.exitCode = 1;
	});
}
