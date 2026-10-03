import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { isInsideProject, primaryCheckout, sameSourcePath } from "./checkouts";
import { canonicalProjectFolder, loadCatalogue } from "./config";

const ROOT = primaryCheckout(resolve(import.meta.dir, ".."));
const POLICY = join(".devhub", "worktree.json");
const TOPIC_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const CODEX_PREFIX = /^codex\//;
const BRANCH_PREFIX = /^refs\/heads\//;
const policySchema = z.strictObject({
	checks: z.array(z.string().trim().min(1)),
	releaseBranch: z.string().min(1),
	stageBranch: z.literal("stage"),
	version: z.literal(1),
	worktreeRoot: z.string().min(1),
});

interface CheckRecord {
	checkedAt: string;
	checks: string[];
	fingerprint: string;
	head: string | null;
}

export interface WorktreeRecord {
	branch?: string;
	head?: string;
	path: string;
}

const HELP = `DevHub: worktree → stage → финальная проверка → явный выпуск
  bun run stage init --project PATH           выделить stage, сохранив локальные правки
  bun run stage create TOPIC --project PATH   codex/TOPIC от чистого stage
  bun run stage integrate REF --project PATH  слить ветку или worktree в чистый stage и проверить
  bun run stage check --project PATH          выполнить проверки из .devhub/worktree.json
  bun run stage status --project PATH         stage, worktree, актуальность проверки
  bun run stage finish PATH --project PATH    убрать чистый, уже влитый worktree

В проекте те же команды доступны через bun/npm run worktree.
DevHub запускает dev только из основной папки. Release-ветка и push требуют отдельного выпуска.
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
	readonly policy: z.infer<typeof policySchema>;
	readonly worktreeRoot: string;
	readonly stateFile: string;
	readonly lockFile: string;

	constructor(folder: string, stateRoot = join(ROOT, ".state", "stage")) {
		this.root = primaryCheckout(folder);
		this.policy = policySchema.parse(
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

	private assertStage(): void {
		if (this.branch() !== this.policy.stageBranch) {
			throw new Error(
				`${this.root}: основная папка должна быть на ветке stage`
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
		if (this.branch() === this.policy.stageBranch) {
			return;
		}
		const current = this.head();
		const stage = gitOutput(
			this.root,
			["rev-parse", "--verify", `refs/heads/${this.policy.stageBranch}`],
			true
		);
		if (!current) {
			if (stage) {
				throw new Error(
					"в репозитории без HEAD уже есть stage; сначала проверьте существующую ветку"
				);
			}
			gitOutput(this.root, ["symbolic-ref", "HEAD", "refs/heads/stage"]);
		} else if (!stage) {
			gitOutput(this.root, ["switch", "-c", this.policy.stageBranch]);
		} else if (stage === current) {
			gitOutput(this.root, ["switch", this.policy.stageBranch]);
		} else {
			throw new Error(
				`${this.root}: stage уже существует на другом коммите; автоматический перенос локальных правок запрещён`
			);
		}
	}

	create(topic: string): string {
		this.assertStage();
		this.assertClean();
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
		if (existsSync(folder)) {
			const existing = this.worktrees().find((item) =>
				sameSourcePath(item.path, folder)
			);
			if (existing?.branch === `codex/${name}`) {
				return folder;
			}
			throw new Error(`путь worktree недоступен: ${folder}`);
		}
		gitOutput(this.root, [
			"worktree",
			"add",
			"-b",
			`codex/${name}`,
			folder,
			"refs/heads/stage",
		]);
		return folder;
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
		this.assertClean();
		const commit = this.resolveSource(source);
		// A failed merge remains visible in stage for conflict resolution; nothing is reset or pushed.
		gitOutput(this.root, ["merge", "--no-ff", "--no-edit", commit]);
		this.check();
	}

	private fingerprint(): string {
		const digest = createHash("sha256");
		digest.update(
			JSON.stringify({
				branch: this.branch(),
				checks: this.policy.checks,
				head: this.head(),
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
		for (const command of this.policy.checks) {
			process.stdout.write(`stage: ${this.root} · ${command}\n`);
			const result = spawnSync(command, {
				cwd: this.root,
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
		const after = this.fingerprint();
		if (before !== after) {
			throw new Error(
				"проверки изменили исходники; проверьте изменения и запустите check повторно"
			);
		}
		writeFileSync(
			this.stateFile,
			`${JSON.stringify(
				{
					checkedAt: new Date().toISOString(),
					checks: this.policy.checks,
					fingerprint: after,
					head: this.head(),
				} satisfies CheckRecord,
				null,
				2
			)}\n`
		);
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
			releaseBranch: this.policy.releaseBranch,
			releaseReady: checked && !dirty && this.branch() === "stage",
			root: this.root,
			worktrees: this.worktrees(),
		};
	}

	finish(folder: string): void {
		this.assertStage();
		this.assertClean();
		if (!this.status().releaseReady) {
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
		if (
			gitOutput(path, [
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
			])
		) {
			throw new Error(
				`${path}: сохраните ignored-файлы вне worktree перед удалением`
			);
		}
		gitOutput(this.root, [
			"merge-base",
			"--is-ancestor",
			worktree.head,
			"refs/heads/stage",
		]);
		gitOutput(this.root, ["worktree", "remove", path]);
	}

	/** Shared by synchronous Git operations and the asynchronous filesystem deletion lifecycle. */
	acquireLock(): () => void {
		let fd: number;
		try {
			fd = openSync(this.lockFile, "wx");
		} catch (cause) {
			throw new Error(`проект занят другим stage-процессом: ${this.lockFile}`, {
				cause,
			});
		}
		const release = () => {
			closeSync(fd);
			rmSync(this.lockFile, { force: true });
		};
		try {
			writeFileSync(fd, `${process.pid}\n`);
		} catch (error) {
			release();
			throw error;
		}
		return release;
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
		} else if (value.startsWith("-")) {
			throw new Error(`неизвестный параметр ${value}`);
		} else {
			operands.push(value);
		}
	}
	return { action, operands, project };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const { action, operands, project } = parseArgs(args);
	if (["help", "--help", "-h"].includes(action)) {
		process.stdout.write(HELP);
		return;
	}
	const takesOperand = ["create", "integrate", "finish"].includes(action);
	if (
		!["init", "create", "integrate", "check", "status", "finish"].includes(
			action
		) ||
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
	stage.withLock(() => {
		if (action === "init") {
			stage.init();
		} else if (action === "create") {
			process.stdout.write(`${stage.create(operands[0] ?? "")}\n`);
		} else if (action === "integrate") {
			stage.integrate(operands[0] ?? "");
		} else if (action === "check") {
			stage.check();
		} else if (action === "finish") {
			stage.finish(operands[0] ?? "");
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
