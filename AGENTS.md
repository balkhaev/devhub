<!-- BEGIN:DEVHUB:WORKTREE-POLICY -->
## DevHub project modes and temporary worktrees — owner policy, 2026-10-03

The canonical checkout is `D:/code/devhub`. Read its [workflow policy](D:/code/devhub/.devhub/worktree.json) and the [shared workflow](D:/code/devhub/WORKTREES.md) before changing repository state. The policy selects MVP (canonical `main`, immediate checked publication) or Prod (canonical `stage`, controlled release).

- Read the canonical `.devhub/worktree.json` before every task. It is the single authority for `mode`, branches, checks, publication and worktree location. Existing policies without `mode` mean Prod until explicitly migrated.
- MVP: integrate the task's own changes into canonical `main`, run final repository checks and inspect the application there, then push `main` and run the configured production release and verify it. The owner's MVP instruction authorizes this publication for every task; do not ask for release permission again. Never include unrelated unfinished work in a task commit or release.
- Prod: integrate into canonical `stage` and perform final checks and application review there. Promote to `main`, push and deploy only when the current task explicitly authorizes release. Project security and production verification requirements apply in both modes.
- Use a temporary isolated `codex/<task>` worktree from the mode's integration branch when isolation is needed; reuse a suitable task worktree rather than another clone. Ordinary worktrees belong in the policy's `worktreeRoot`, under `D:/worktrees/<project>`, outside `D:/code`.
- DevHub starts every dev service from the canonical project folder. Never run a dev server from a linked worktree or register a worktree as another application. Worktree dev commands route to the canonical checkout and show integrated code.
- Use `bun D:/code/devhub/src/stage.ts create|integrate|check|status|publish|mode|finish --project <canonical-path> [operand]`. JavaScript repositories also expose `bun run worktree` / `npm run worktree --`. Mode changes use `mode mvp` or `mode prod`; divergent branch history is a blocker, never a reason to reset or force-push.
- Preserve unrelated edits, untracked files, private ignored files and other agents' work. Never reset, stash all changes, force-remove another task or bulk-merge historical worktrees. If integration or publication fails, report the concrete blocker and preserve the task for recovery.
- Leave no task worktree behind when the task ends, including failed tasks. For a completed ordinary worktree use `finish <full-worktree-path>` after its commits are contained in the integration branch; preserve private files outside `D:/code` before removal. For unfinished work preserve its branch, commits, changes and private files in a recovery archive before removing the checkout. Use the Codex app's archive operation for Codex-managed worktrees so attachments remain consistent.

Production `build`, `start`, `deploy` and container entrypoints remain standalone. This mode-aware owner policy supersedes earlier all-stage, direct-main and worktree lifecycle rules where they conflict.
<!-- END:DEVHUB:WORKTREE-POLICY -->

