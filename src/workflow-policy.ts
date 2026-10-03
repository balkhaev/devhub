import { z } from "zod";

const MODE_FIELD = /("mode"\s*:\s*)"(?:mvp|prod)"/;
const PROPERTY_INDENT = /\n([\t ]+)"/;

export const projectModeSchema = z.enum(["mvp", "prod"]);
export type ProjectMode = z.infer<typeof projectModeSchema>;

/** One repository-owned policy controls the UI and the agent workflow. */
export const workflowPolicySchema = z.strictObject({
	checks: z.array(z.string().trim().min(1)),
	/** Optional standalone production command; otherwise a main push triggers the configured CI. */
	deploy: z.string().trim().min(1).optional(),
	// Existing staging projects stay cautious until explicitly migrated.
	mode: projectModeSchema.default("prod"),
	releaseBranch: z.string().min(1),
	/** Null explicitly keeps this project local; missing remotes still fail publication. */
	remote: z.string().min(1).nullable().default("origin"),
	stageBranch: z.literal("stage"),
	version: z.literal(1),
	worktreeRoot: z.string().min(1),
});

export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;

/** Keep repository formatting and unrelated JSON fields unchanged when switching modes. */
export function withProjectModeText(before: string, mode: ProjectMode): string {
	const original = JSON.parse(before);
	workflowPolicySchema.parse(original);
	if (Object.hasOwn(original, "mode")) {
		const updated = before.replace(MODE_FIELD, `$1"${mode}"`);
		if (workflowPolicySchema.parse(JSON.parse(updated)).mode !== mode) {
			throw new Error("нормализуйте ключ mode в политике перед сменой режима");
		}
		return updated;
	}
	const closing = before.lastIndexOf("}");
	const indent = PROPERTY_INDENT.exec(before)?.[1] ?? "  ";
	const line = before.includes("\r\n") ? "\r\n" : "\n";
	// Parsing above validates the object before editing its final top-level property.
	return `${before.slice(0, closing).trimEnd()},${line}${indent}"mode": "${mode}"${line}${before.slice(closing)}`;
}
