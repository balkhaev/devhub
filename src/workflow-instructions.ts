export const WORKFLOW_POLICY_MARKER = "DEVHUB:WORKTREE-POLICY";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

const rules = `- Read the canonical \`.devhub/worktree.json\` before every task. It is the single authority for \`mode\`, branches, checks, publication and worktree location. Existing policies without \`mode\` mean Prod until explicitly migrated.
- MVP: integrate the task's own changes into canonical \`main\`, run final repository checks and inspect the application there, then push \`main\` and run the configured production release and verify it. Explicit \`remote: null\` means a local-only project: retain checked changes in local \`main\` without push or cloud deployment. The owner's MVP instruction authorizes this publication for every task; do not ask for release permission again. Never include unrelated unfinished work in a task commit or release.
- Prod: integrate into canonical \`stage\` and perform final checks and application review there. Promote to \`main\`, push and deploy only when the current task explicitly authorizes release. Project security and production verification requirements apply in both modes.
- Use a temporary isolated \`codex/<task>\` worktree from the mode's integration branch when isolation is needed; reuse a suitable task worktree rather than another clone. Ordinary worktrees belong in the policy's \`worktreeRoot\`, under \`D:/worktrees/<project>\`, outside \`D:/code\`.
- DevHub starts every dev service from the canonical project folder. Never run a dev server from a linked worktree or register a worktree as another application. Worktree dev commands route to the canonical checkout and show integrated code.
- Use \`bun D:/code/devhub/src/stage.ts create|integrate|check|status|publish|mode|finish --project <canonical-path> [operand]\`. JavaScript repositories also expose \`bun run worktree\` / \`npm run worktree --\`. Mode changes use \`mode mvp\` or \`mode prod\`; divergent branch history is a blocker, never a reason to reset or force-push.
- Preserve unrelated edits, untracked files, private ignored files and other agents' work. Never reset, stash all changes, force-remove another task or bulk-merge historical worktrees. If integration or publication fails, report the concrete blocker and preserve the task for recovery.
- Leave no task worktree behind when the task ends, including failed tasks. For a completed ordinary worktree use \`finish <full-worktree-path>\` after its commits are contained in the integration branch; preserve private files outside \`D:/code\` before removal. For unfinished work preserve its branch, commits, changes and private files in a recovery archive before removing the checkout. Use the Codex app's archive operation for Codex-managed worktrees so attachments remain consistent.

Production \`build\`, \`start\`, \`deploy\` and container entrypoints remain standalone. This mode-aware owner policy supersedes earlier all-stage, direct-main and worktree lifecycle rules where they conflict.`;

export function ownerProjectPolicyBlock(primary: string): string {
	const folder = primary.replaceAll("\\", "/");
	return `<!-- BEGIN:${WORKFLOW_POLICY_MARKER} -->
## DevHub project modes and temporary worktrees — owner policy, 2026-10-03

The canonical checkout is \`${folder}\`. Read its [workflow policy](${folder}/.devhub/worktree.json) and the [shared workflow](D:/code/devhub/WORKTREES.md) before changing repository state. The policy selects MVP (canonical \`main\`, immediate checked publication) or Prod (canonical \`stage\`, controlled release).

${rules}
<!-- END:${WORKFLOW_POLICY_MARKER} -->`;
}

/** Generated proposal for collection AGENTS.md; callers choose whether to apply it. */
export function ownerParentPolicyBlock(): string {
	return `<!-- BEGIN:${WORKFLOW_POLICY_MARKER} -->
## DevHub project modes and temporary worktrees — owner policy, 2026-10-03

\`D:/code\` contains canonical project folders. Temporary worktrees live under \`D:/worktrees\`; recovery archives live outside \`D:/code\`. Read the project's canonical \`.devhub/worktree.json\` and [D:/code/devhub/WORKTREES.md](D:/code/devhub/WORKTREES.md). New projects start in MVP; moving to Prod enables controlled staging and release.

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
