import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { holderRows, type ProcessSurvey } from "./holders";

/**
 * When a leftover folder was last in use. Three things count as use: the folder itself changed, a process started
 * working in it, or an agent session opened in it wrote to its log (every message and every tool call does). A
 * folder nobody used for a day is removed by itself, with the processes that still hold it.
 */

const NOT_ALPHANUMERIC = /[^a-zA-Z0-9]/g;

/** Claude Code keeps the log of each session in a folder named after the folder the session works in. */
export const claudeLogs = (): string =>
	join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** When a file or folder last changed, in epoch milliseconds; zero when it is not there. */
export const changedAt = (path: string): number =>
	statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/**
 * The newest write to the logs of sessions that work in the folder or below it. A neighbour whose name only begins
 * the same way counts too: a folder kept a little longer costs less than a session ended while in use.
 */
function logUse(folder: string, logs: string): number {
	const name = resolve(folder).replace(NOT_ALPHANUMERIC, "-").toLowerCase();
	let sessions: Dirent[];
	try {
		sessions = readdirSync(logs, { withFileTypes: true });
	} catch {
		return 0;
	}
	let newest = 0;
	for (const session of sessions) {
		const candidate = session.name.toLowerCase();
		if (
			!(
				session.isDirectory() &&
				(candidate === name || candidate.startsWith(`${name}-`))
			)
		) {
			continue;
		}
		try {
			for (const file of readdirSync(join(logs, session.name))) {
				newest = Math.max(newest, changedAt(join(logs, session.name, file)));
			}
		} catch {
			// A log folder that cannot be read says nothing.
		}
	}
	return newest;
}

/** The latest moment a folder is known to have been in use, in epoch milliseconds. */
export function lastUse(
	folder: string,
	survey: ProcessSurvey,
	logs: string
): number {
	return Math.max(
		changedAt(folder),
		logUse(folder, logs),
		...holderRows(folder, survey).map((row) => row.started ?? 0)
	);
}
