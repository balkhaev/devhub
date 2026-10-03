import { z } from "zod";

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
