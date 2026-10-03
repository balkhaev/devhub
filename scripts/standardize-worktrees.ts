import { main } from "./project-modes";

/** Compatibility entrypoint. The old all-stage bulk installer is replaced by reviewed mode plans. */
if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`devhub standardize worktrees: ${(error as Error).message}\n`
		);
		process.exitCode = 1;
	});
}
