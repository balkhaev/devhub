import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { archiveWorktree } from "../src/worktree-archive";

const fixtures: string[] = [];

function git(folder: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", folder, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `Fixture Git failed: ${args[0]}`);
	}
	return result.stdout.trimEnd();
}

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "devhub-archive-test-"));
	fixtures.push(base);
	const project = join(base, "project");
	const allowedRoot = join(base, "worktrees");
	const archiveRoot = join(base, "archives");
	const worktree = join(allowedRoot, "legacy");
	mkdirSync(project);
	mkdirSync(allowedRoot);
	git(project, "init", "--initial-branch=main");
	git(project, "config", "user.name", "DevHub archive fixture");
	git(project, "config", "user.email", "fixture@example.test");
	git(project, "config", "commit.gpgsign", "false");
	git(project, "config", "core.autocrlf", "false");
	const hooks = join(base, "hooks");
	mkdirSync(hooks);
	git(project, "config", "core.hooksPath", hooks);
	writeFileSync(join(project, ".gitignore"), "ignored/\nnode_modules/\n");
	writeFileSync(join(project, "source.txt"), "original\n");
	writeFileSync(join(project, "binary.bin"), Buffer.from([0, 1, 2, 3]));
	git(project, "add", ".");
	git(project, "commit", "-m", "Initial fixture");
	git(project, "worktree", "add", "-b", "codex/legacy", worktree);
	return { allowedRoot, archiveRoot, base, project, worktree };
}

afterEach(() => {
	for (const folder of fixtures.splice(0)) {
		const absolute = resolve(folder);
		if (
			dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
			!basename(absolute).startsWith("devhub-archive-test-")
		) {
			throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
		}
		rmSync(absolute, { force: true, recursive: true });
	}
});

describe("ordinary worktree archival with real disposable Git repositories", () => {
	test("refuses a concurrent source change made by a real Git reference transaction hook", () => {
		const options = fixture();
		const source = join(options.worktree, "source.txt")
			.replaceAll("\\", "/")
			.replaceAll("'", "'\\''");
		writeFileSync(
			join(options.base, "hooks", "reference-transaction"),
			`#!/bin/sh\nif [ "$1" = committed ]; then\n  printf 'concurrent edit\\n' > '${source}'\nfi\n`,
			{ mode: 0o755 }
		);
		const primaryHead = git(options.project, "rev-parse", "HEAD");
		expect(() => archiveWorktree(options)).toThrow(
			"изменился во время сохранения"
		);
		expect(existsSync(join(options.worktree, ".git"))).toBe(true);
		expect(readFileSync(join(options.worktree, "source.txt"), "utf8")).toBe(
			"concurrent edit\n"
		);
		expect(git(options.project, "rev-parse", "HEAD")).toBe(primaryHead);
		expect(git(options.project, "worktree", "list", "--porcelain")).toContain(
			options.worktree.replaceAll("\\", "/")
		);
	});

	test("Git removes only an already-moved checkout registration without force", () => {
		const options = fixture();
		const moved = join(options.base, "moved");
		const other = join(options.allowedRoot, "other");
		git(options.project, "worktree", "add", "-b", "codex/other", other);
		renameSync(options.worktree, moved);
		git(options.project, "worktree", "remove", options.worktree);
		expect(git(options.project, "worktree", "list", "--porcelain")).toContain(
			other.replaceAll("\\", "/")
		);
		expect(readFileSync(join(moved, "source.txt"), "utf8")).toBe("original\n");
		expect(git(other, "rev-parse", "HEAD")).toBe(
			git(options.project, "rev-parse", "HEAD")
		);
	});

	test("preserves unique commits, staged binary data, dirty files and ignored private data", () => {
		const options = fixture();
		const { project, worktree, allowedRoot } = options;
		writeFileSync(join(worktree, "source.txt"), "unique commit\n");
		git(worktree, "add", "source.txt");
		git(worktree, "commit", "-m", "Unique unfinished task");
		const uniqueHead = git(worktree, "rev-parse", "HEAD");
		writeFileSync(join(worktree, "source.txt"), "staged\n");
		const stagedBinary = Buffer.from([0, 255, 8, 13]);
		writeFileSync(join(worktree, "binary.bin"), stagedBinary);
		git(worktree, "add", "source.txt", "binary.bin");
		writeFileSync(join(worktree, "source.txt"), "unstaged\n");
		writeFileSync(join(worktree, "binary.bin"), Buffer.from([0, 7, 9, 255]));
		writeFileSync(join(worktree, "draft.txt"), "untracked draft\n");
		mkdirSync(join(worktree, "ignored"));
		writeFileSync(
			join(worktree, "ignored", "private.env"),
			"PRIVATE_FIXTURE=preserved\n"
		);
		const pointer = readFileSync(join(worktree, ".git"), "utf8");
		const record = pointer.trim().slice("gitdir: ".length);
		const index = readFileSync(join(record, "index"));
		const primaryHead = git(project, "rev-parse", "HEAD");
		writeFileSync(join(project, "source.txt"), "unrelated primary work\n");
		const primaryStatus = git(project, "status", "--porcelain");
		const other = join(allowedRoot, "other");
		git(project, "worktree", "add", "-b", "codex/other", other);
		const otherPointer = readFileSync(join(other, ".git"), "utf8");
		const archived = archiveWorktree(options);
		const files = join(archived, "files");
		const metadata = JSON.parse(
			readFileSync(join(archived, "archive.json"), "utf8")
		);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(join(files, ".git"))).toBe(false);
		expect(existsSync(record)).toBe(false);
		expect(metadata.state).toBe("archived");
		expect(metadata.head).toBe(uniqueHead);
		expect(git(project, "rev-parse", metadata.archiveRef)).toBe(uniqueHead);
		git(project, "update-ref", "-d", "refs/heads/codex/legacy");
		expect(
			git(
				project,
				"for-each-ref",
				"--format=%(refname)",
				`--contains=${uniqueHead}`,
				"refs/archive/devhub"
			)
		).toBe(metadata.archiveRef);
		expect(readFileSync(join(files, "source.txt"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(files, "binary.bin"))).toEqual(
			Buffer.from([0, 7, 9, 255])
		);
		expect(readFileSync(join(files, "draft.txt"), "utf8")).toBe(
			"untracked draft\n"
		);
		expect(readFileSync(join(files, "ignored", "private.env"), "utf8")).toBe(
			"PRIVATE_FIXTURE=preserved\n"
		);
		expect(readFileSync(join(archived, "index.bin"))).toEqual(index);
		expect(readFileSync(join(archived, "git-record", "index"))).toEqual(index);
		expect(readFileSync(join(archived, "git-pointer.txt"), "utf8")).toBe(
			pointer
		);
		expect(readFileSync(join(archived, "staged.patch"), "utf8")).toContain(
			"GIT binary patch"
		);
		expect(readFileSync(join(archived, "unstaged.patch"), "utf8")).toContain(
			"GIT binary patch"
		);
		expect(git(project, "worktree", "list", "--porcelain")).not.toContain(
			`worktree ${worktree.replaceAll("\\", "/")}\n`
		);
		expect(readFileSync(join(other, ".git"), "utf8")).toBe(otherPointer);
		expect(git(other, "rev-parse", "HEAD")).toBe(primaryHead);
		expect(git(project, "status", "--porcelain")).toBe(primaryStatus);
		expect(git(project, "rev-parse", "HEAD")).toBe(primaryHead);
	});

	test("atomic rename preserves internal junctions and leaves their shared target intact", () => {
		const options = fixture();
		const shared = join(options.base, "shared-assets");
		mkdirSync(shared);
		writeFileSync(join(shared, "source.bin"), "shared data\n");
		const link = join(options.worktree, "node_modules");
		symlinkSync(
			shared,
			link,
			process.platform === "win32" ? "junction" : "dir"
		);
		const target = readlinkSync(link);
		const archived = archiveWorktree(options);
		const archivedLink = join(archived, "files", "node_modules");
		expect(lstatSync(archivedLink).isSymbolicLink()).toBe(true);
		expect(readlinkSync(archivedLink)).toBe(target);
		expect(readFileSync(join(shared, "source.bin"), "utf8")).toBe(
			"shared data\n"
		);
	});

	test("explicit legacy cleanup archives a registered nested worktree and preserves its primary project", () => {
		const options = fixture();
		const nestedRoot = join(options.project, ".claude", "worktrees");
		const nested = join(nestedRoot, "old-task");
		writeFileSync(
			join(options.project, ".gitignore"),
			"ignored/\nnode_modules/\n.claude/\n"
		);
		writeFileSync(
			join(options.project, "primary-draft.txt"),
			"primary private draft\n"
		);
		git(
			options.project,
			"worktree",
			"add",
			"-b",
			"codex/nested-legacy",
			nested
		);
		writeFileSync(join(nested, "source.txt"), "nested unique commit\n");
		git(nested, "add", "source.txt");
		git(nested, "commit", "-m", "Nested unfinished task");
		const head = git(nested, "rev-parse", "HEAD");
		mkdirSync(join(nested, "ignored"));
		writeFileSync(
			join(nested, "ignored", "private.env"),
			"NESTED_FIXTURE=preserved\n"
		);
		const primaryHead = git(options.project, "rev-parse", "HEAD");
		const primaryStatus = git(options.project, "status", "--porcelain");
		const archiveOptions = {
			...options,
			allowedRoot: nestedRoot,
			worktree: nested,
		};
		expect(() => archiveWorktree(archiveOptions)).toThrow("Основную папку");
		const archived = archiveWorktree({
			...archiveOptions,
			allowNestedLegacy: true,
		});
		const metadata = JSON.parse(
			readFileSync(join(archived, "archive.json"), "utf8")
		);
		expect(git(options.project, "rev-parse", metadata.archiveRef)).toBe(head);
		expect(
			readFileSync(join(archived, "files", "ignored", "private.env"), "utf8")
		).toBe("NESTED_FIXTURE=preserved\n");
		expect(git(options.project, "rev-parse", "HEAD")).toBe(primaryHead);
		expect(git(options.project, "status", "--porcelain")).toBe(primaryStatus);
		expect(readFileSync(join(options.project, "source.txt"), "utf8")).toBe(
			"original\n"
		);
		expect(
			readFileSync(join(options.project, "primary-draft.txt"), "utf8")
		).toBe("primary private draft\n");
		expect(existsSync(join(options.worktree, ".git"))).toBe(true);
		expect(() =>
			archiveWorktree({
				...options,
				allowedRoot: options.base,
				allowNestedLegacy: true,
				worktree: options.project,
			})
		).toThrow("Основную папку");
	});

	test("refuses the canonical checkout and a linked checkout used as project", () => {
		const options = fixture();
		expect(() =>
			archiveWorktree({
				...options,
				allowedRoot: options.base,
				worktree: options.project,
			})
		).toThrow("Основную папку");
		expect(() =>
			archiveWorktree({ ...options, project: options.worktree })
		).toThrow("основной папкой Git");
		expect(existsSync(join(options.project, ".git"))).toBe(true);
		expect(existsSync(join(options.worktree, ".git"))).toBe(true);
	});

	test("refuses outside paths, a source junction and an archive inside the cleanup root", () => {
		const options = fixture();
		const elsewhere = join(options.base, "elsewhere");
		mkdirSync(elsewhere);
		expect(() =>
			archiveWorktree({ ...options, allowedRoot: elsewhere })
		).toThrow("вне разрешённой");
		const alias = join(options.allowedRoot, "alias");
		symlinkSync(
			options.worktree,
			alias,
			process.platform === "win32" ? "junction" : "dir"
		);
		expect(() => archiveWorktree({ ...options, worktree: alias })).toThrow(
			"junction/symlink"
		);
		expect(() =>
			archiveWorktree({
				...options,
				archiveRoot: join(options.allowedRoot, "archives"),
			})
		).toThrow("Архив должен");
		expect(existsSync(join(options.worktree, ".git"))).toBe(true);
	});

	test("refuses a worktree from another repository, Git lock and active task paths", () => {
		const options = fixture();
		const foreign = fixture();
		expect(() =>
			archiveWorktree({ ...options, project: foreign.project })
		).toThrow("другому репозиторию");
		git(
			options.project,
			"worktree",
			"lock",
			"--reason",
			"Fixture active task",
			options.worktree
		);
		expect(() => archiveWorktree(options)).toThrow("заблокирован");
		git(options.project, "worktree", "unlock", options.worktree);
		expect(() =>
			archiveWorktree({
				...options,
				activePaths: [join(options.worktree, "apps", "web")],
			})
		).toThrow("активной задачей");
		expect(existsSync(join(options.worktree, ".git"))).toBe(true);
		expect(git(options.project, "for-each-ref", "refs/archive/devhub")).toBe(
			""
		);
	});
});
