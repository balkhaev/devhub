<!-- BEGIN:DEVHUB:DEV-SERVER -->
## DevHub is the development server — owner policy, 2026-10-04

DevHub (`D:/code/devhub`, http://127.0.0.1:4700/) owns every local dev server on this computer. Agents start, inspect and stop development services only through it.

- Start: `bun D:/code/devhub/src/cli.ts start <project>[/<service>]` or the project's registered `bun run dev` / `dev:*` scripts, which delegate to DevHub. The command returns after readiness; a repeated start reuses the running process.
- Inspect: `bun D:/code/devhub/src/cli.ts status [--json]`, `bun D:/code/devhub/src/cli.ts list`, `bun D:/code/devhub/src/cli.ts logs <project>/<service> [--lines N]`. Stop or restart with `bun D:/code/devhub/src/cli.ts stop|restart <project>/<service>`.
- Browser preview: `.claude/launch.json` entries run `bun D:/code/devhub/src/cli.ts attach <project>/<service>`, which starts the service in DevHub and follows its log. Or start it through DevHub and open `http://localhost:<port>/`.
- Never run `next dev`, `vite`, `bun --hot`, `node --watch`, `turbo dev`, `uvicorn --reload`, `expo start`, `wrangler dev` and similar directly, in the background or through another process manager. Never kill a process to free a port; a port held outside DevHub needs an explicit migration.
- New or changed services are described in the project's `devhub.json` (command, relative cwd, port, health, env, needs, launch); restart the hub afterwards. New projects are created from the hub page («Новый проект») or `bun D:/code/devhub/src/cli.ts create bts|python <name>`, which registers them.
- Production: `bun D:/code/devhub/src/cli.ts prod [<project>]` shows the project's Coolify applications, databases and services with status, domains and commit; `bun D:/code/devhub/src/cli.ts prod <project> --logs` adds each application's last deployment and recent logs. The hub page «Прод» shows the same with deployment history. Production `build`, `start`, `deploy` and containers stay standalone and never depend on DevHub.
<!-- END:DEVHUB:DEV-SERVER -->

<!-- BEGIN:DEVHUB:WORKTREE-POLICY -->
## DevHub project modes and temporary worktrees — owner policy, 2026-10-03

The canonical checkout is `D:/code/devhub`. Read its [workflow policy](D:/code/devhub/.devhub/worktree.json) and the [shared workflow](D:/code/devhub/WORKTREES.md) before changing repository state. The policy selects MVP (canonical `main`, immediate checked publication) or Prod (canonical `stage`, controlled release).

- Read the canonical `.devhub/worktree.json` before every task. It is the single authority for `mode`, branches, checks, publication and worktree location. Existing policies without `mode` mean Prod until explicitly migrated.
- MVP: integrate the task's own changes into canonical `main`, run final repository checks and inspect the application there, then push `main` and run the configured production release and verify it. Explicit `remote: null` means a local-only project: retain checked changes in local `main` without push or cloud deployment. The owner's MVP instruction authorizes this publication for every task; do not ask for release permission again. Never include unrelated unfinished work in a task commit or release.
- Prod: integrate into canonical `stage` and perform final checks and application review there. Promote to `main`, push and deploy only when the current task explicitly authorizes release. Project security and production verification requirements apply in both modes.
- Use a temporary isolated `codex/<task>` worktree from the mode's integration branch when isolation is needed; reuse a suitable task worktree rather than another clone. Ordinary worktrees belong in the policy's `worktreeRoot`, under `D:/worktrees/<project>`, outside `D:/code`.
- DevHub starts every dev service from the canonical project folder. Never run a dev server from a linked worktree or register a worktree as another application. Worktree dev commands route to the canonical checkout and show integrated code.
- Use `bun D:/code/devhub/src/stage.ts create|integrate|check|status|publish|mode|finish --project <canonical-path> [operand]`. JavaScript repositories also expose `bun run worktree` / `npm run worktree --`. Mode changes use `mode mvp` or `mode prod`; divergent branch history is a blocker, never a reason to reset or force-push.
- Preserve unrelated edits, untracked files, private ignored files and other agents' work. Never reset, stash all changes, force-remove another task or bulk-merge historical worktrees. If integration or publication fails, report the concrete blocker and preserve the task for recovery.
- Leave no task worktree behind when the task ends, including failed tasks. For a completed ordinary worktree use `finish <full-worktree-path>` after its commits are contained in the integration branch; preserve private files outside `D:/code` before removal. For unfinished work preserve its branch, commits, changes and private files in a recovery archive before removing the checkout. Use the Codex app's archive operation for Codex-managed worktrees so attachments remain consistent.

Production `build`, `start`, `deploy` and container entrypoints remain standalone. This mode-aware owner policy supersedes earlier all-stage, direct-main and worktree lifecycle rules where they conflict.
<!-- END:DEVHUB:WORKTREE-POLICY -->

