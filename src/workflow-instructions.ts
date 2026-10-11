export const WORKFLOW_POLICY_MARKER = "DEVHUB:WORKTREE-POLICY";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

const rules = `- Read the canonical \`.devhub/worktree.json\` before every task. It is the single authority for \`mode\`, branches, checks, publication and worktree location. Existing policies without \`mode\` mean Prod until explicitly migrated.
- MVP: integrate the task's own changes into canonical \`main\`, run final repository checks and inspect the application there, then push \`main\` and run the configured production release and verify it. Explicit \`remote: null\` means a local-only project: retain checked changes in local \`main\` without push or cloud deployment. The owner's MVP instruction authorizes this publication for every task; do not ask for release permission again. Never include unrelated unfinished work in a task commit or release.
- Prod: integrate into canonical \`stage\` and perform final checks and application review there. Promote to \`main\`, push and deploy only when the current task explicitly authorizes release. Project security and production verification requirements apply in both modes.
- Use a temporary isolated \`codex/<task>\` worktree from the mode's integration branch when isolation is needed; reuse a suitable task worktree rather than another clone. Ordinary worktrees belong in the policy's \`worktreeRoot\`, under \`F:/worktrees/<project>\`, outside \`F:/code\`.
- DevHub starts every dev service from the canonical project folder. Never run a dev server from a linked worktree or register a worktree as another application. Worktree dev commands route to the canonical checkout and show integrated code.
- Use \`bun F:/code/devhub/src/stage.ts create|integrate|check|status|publish|mode|finish|close --project <canonical-path> [operand]\`. JavaScript repositories also expose \`bun run worktree\` / \`npm run worktree --\`. Mode changes use \`mode mvp\` or \`mode prod\`; divergent branch history is a blocker, never a reason to reset or force-push.
- Preserve unrelated edits, untracked files, private ignored files and other agents' work. Never reset, stash all changes, force-remove another task or bulk-merge historical worktrees. If integration or publication fails, report the concrete blocker and preserve the task for recovery.
- Worktrees have only two lifecycle states: working and closed. Close a completed ordinary worktree with \`finish <full-worktree-path>\` after its commits are contained in the checked integration branch: the folder and the merged task branch are removed. A clean committed task can be closed with \`close\` without integrating it; its Git branch is retained as parked work. Archives are not created. Unsaved changes, private ignored files, a detached HEAD or a locked worktree prevent closing; keep the worktree working until those are resolved. Dependency and cache folders (\`node_modules\`, \`.venv\`, tool caches) go with the worktree. Never use the Codex archive operation as a substitute for closing.
- Leave nothing behind. History lives only in Git: no backup copies, before/after snapshots, dated folders or evidence folders. State too heavy for Git (models, runtimes, user data) belongs in \`F:/AI/<project folder>\`; temporary files belong in the session's scratch folder. A task is finished when \`bun F:/code/devhub/src/cli.ts tidy <project>\` shows nothing of its own; \`tidy --apply\` removes merged closed branches and worktree records without a folder.

Production \`build\`, \`start\`, \`deploy\` and container entrypoints remain standalone. This mode-aware owner policy supersedes earlier all-stage, direct-main and worktree lifecycle rules where they conflict.`;

/**
 * A repository only points at the rules: their text is kept once, in the machine-wide instruction files,
 * so changing a rule edits no repository and no worktree.
 */
export function ownerProjectPolicyBlock(primary: string): string {
	const folder = primary.replaceAll("\\", "/");
	return `<!-- BEGIN:${WORKFLOW_POLICY_MARKER} -->
## DevHub workflow — owner policy

The canonical checkout is \`${folder}\`; its mode, checks and worktree folder are in [.devhub/worktree.json](${folder}/.devhub/worktree.json). The owner's rules for this machine (dev servers only through DevHub, project modes, temporary worktrees, leaving nothing behind) are kept once, in \`F:/code/AGENTS.md\`; \`F:/worktrees/AGENTS.md\` and the global agent instructions carry the same text. Read them before changing repository state.
<!-- END:${WORKFLOW_POLICY_MARKER} -->`;
}

/** The full rules, for the machine-wide instruction files above every checkout. */
export function ownerParentPolicyBlock(): string {
	return `<!-- BEGIN:${WORKFLOW_POLICY_MARKER} -->
## DevHub project modes and temporary worktrees — owner policy, 2026-10-11

\`F:/code\` contains canonical project folders. Working worktrees live under \`F:/worktrees/<project folder>\`; a finished task leaves neither a folder nor a branch, and a branch without a folder is parked work. State too heavy for Git lives under \`F:/AI/<project folder>\`. Archives are not created. Read the project's canonical \`.devhub/worktree.json\` and [F:/code/devhub/WORKTREES.md](F:/code/devhub/WORKTREES.md). New projects start in MVP; moving to Prod enables controlled staging and release.

${rules}
<!-- END:${WORKFLOW_POLICY_MARKER} -->`;
}

/** Replace only the owner-owned marker, preserving other instructions and front matter byte-for-byte. */
export function replaceOwnerPolicyBlock(before: string, block: string): string {
	const line = before.includes("\r\n") ? "\r\n" : "\n";
	const replacement = block.replaceAll("\n", line);
	const pattern = new RegExp(
		`<!-- BEGIN:${WORKFLOW_POLICY_MARKER} -->[\\s\\S]*?<!-- END:${WORKFLOW_POLICY_MARKER} -->`,
		"g"
	);
	const matches = [...before.matchAll(pattern)];
	if (matches.length > 1) {
		throw new Error(
			"несколько owner policy блоков; сначала проверьте инструкции вручную"
		);
	}
	if (matches.length === 1) {
		return before.replace(pattern, replacement);
	}
	if (
		before.includes(`<!-- BEGIN:${WORKFLOW_POLICY_MARKER} -->`) ||
		before.includes(`<!-- END:${WORKFLOW_POLICY_MARKER} -->`)
	) {
		throw new Error("незавершённый owner policy блок; инструкции сохранены");
	}
	const frontmatter = FRONTMATTER.exec(before)?.[0] ?? "";
	return `${frontmatter}${replacement}${line}${line}${before.slice(frontmatter.length)}`;
}
