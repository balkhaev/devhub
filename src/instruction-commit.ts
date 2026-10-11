import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withoutDevhubRewrites } from "./agents";
import { gitOutput, StageProject } from "./stage";

/**
 * DevHub commits its own rewrite of a project's instructions at once: left uncommitted it keeps the canonical
 * folder and every worktree dirty and blocks closing them. A file that also holds someone's edits is left to its
 * author, and so is a project in the middle of a merge or of another stage command. Nothing is pushed.
 * Returns what happened in words, or null when no listed file differs from HEAD.
 */
export function commitOwnRewrites(
	root: string,
	files: string[],
	message: string
): string | null {
	if (!existsSync(join(root, ".devhub", "worktree.json"))) {
		return null;
	}
	const changed = files.filter((file) =>
		gitOutput(root, ["status", "--porcelain", "--", file], true)
	);
	if (changed.length === 0) {
		return null;
	}
	if (
		gitOutput(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], true)
	) {
		return "не закоммичено: в основной папке идёт merge";
	}
	const foreign = changed.filter(
		(file) =>
			withoutDevhubRewrites(gitOutput(root, ["show", `HEAD:${file}`], true)) !==
			withoutDevhubRewrites(
				existsSync(join(root, file))
					? readFileSync(join(root, file), "utf8")
					: ""
			)
	);
	const own = changed.filter((file) => !foreign.includes(file));
	const kept = foreign.length
		? `не закоммичено: в ${foreign.join(", ")} есть чужие правки`
		: "";
	if (own.length === 0) {
		return kept;
	}
	try {
		const stage = new StageProject(root);
		const done = stage.withLock(() => {
			gitOutput(root, ["add", "--", ...own]);
			try {
				gitOutput(root, ["commit", "--only", "-m", message, "--", ...own]);
			} catch (error) {
				gitOutput(root, ["restore", "--staged", "--", ...own], true);
				throw error;
			}
			return `закоммичено: ${own.join(", ")}`;
		});
		return [done, kept].filter(Boolean).join("; ");
	} catch (error) {
		return `не закоммичено: ${(error as Error).message.split("\n")[0]}`;
	}
}
