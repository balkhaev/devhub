import { dirname, resolve } from "node:path";
import { stdin } from "bun";

import { guardReason, type HookInput } from "./agents";

/**
 * Claude Code PreToolUse hook: refuses a dev server started around DevHub in a DevHub project. It reads the hook
 * input from stdin and answers with a deny decision; any unexpected input lets the tool call run unchanged.
 */

const ROOT = resolve(dirname(import.meta.dir));

try {
	const input = JSON.parse(await stdin.text()) as HookInput;
	const reason = guardReason(input, ROOT);
	if (reason) {
		process.stdout.write(
			`${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: reason,
				},
			})}\n`
		);
	}
} catch {
	// A broken guard must never block the agent's work.
}
