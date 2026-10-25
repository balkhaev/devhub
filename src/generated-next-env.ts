import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import { isInsideProject, sameSourcePath } from "./checkouts";

const CRLF = /\r\n/g;
const MAX_GENERATED_BYTES = 2048;
const nextDependency = z.object({ next: z.string().trim().min(1).optional() });
const nextPackage = z.object({
	dependencies: nextDependency.optional(),
	devDependencies: nextDependency.optional(),
});
const templates = new Set(
	[".next/types/routes.d.ts", ".next/dev/types/routes.d.ts"].map((routes) =>
		[
			'/// <reference types="next" />',
			'/// <reference types="next/image-types/global" />',
			`import "./${routes}";`,
			"",
			"// NOTE: This file should not be edited",
			"// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
			"",
		].join("\n")
	)
);

/** Only known Next-generated content is disposable; the filename alone proves nothing. */
export function isGeneratedNextEnv(root: string, entry: string): boolean {
	if (basename(entry) !== "next-env.d.ts") {
		return false;
	}
	const file = resolve(root, entry);
	if (!isInsideProject(root, file)) {
		return false;
	}
	try {
		// Do not classify content reached through a symlink/junction as generated state.
		let folder = dirname(file);
		for (;;) {
			const info = lstatSync(folder);
			if (!info.isDirectory() || info.isSymbolicLink()) {
				return false;
			}
			if (sameSourcePath(folder, root)) {
				break;
			}
			folder = dirname(folder);
		}
		const info = lstatSync(file);
		const manifest = join(dirname(file), "package.json");
		if (
			!info.isFile() ||
			info.size > MAX_GENERATED_BYTES ||
			!lstatSync(manifest).isFile()
		) {
			return false;
		}
		const parsed = nextPackage.safeParse(
			JSON.parse(readFileSync(manifest, "utf8"))
		);
		return (
			parsed.success &&
			Boolean(
				parsed.data.dependencies?.next || parsed.data.devDependencies?.next
			) &&
			templates.has(readFileSync(file, "utf8").replace(CRLF, "\n"))
		);
	} catch {
		// Missing, unreadable or malformed files retain the normal private-file protection.
		return false;
	}
}
