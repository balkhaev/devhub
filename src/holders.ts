import { spawnSync } from "node:child_process";
import {
	chmodSync,
	type Dirent,
	existsSync,
	readdirSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { sleepSync } from "bun";

/**
 * Removing a folder that processes still use. Windows refuses to delete a folder while a process works in it, runs
 * a program from it or keeps one of its files open, so a closed task's folder used to stay behind. The folder's
 * holders are found, ended and the folder is removed. Two kinds are never ended: the session this command itself
 * runs in (it would not live to report) and Windows' own processes; the folder then stays for the next tidy.
 * Callers decide beforehand that the folder holds no work.
 */

const WINDOWS = process.platform === "win32";
const SCRIPT = join(import.meta.dir, "holders.ps1");
const SURVEY_MS = 60_000;
const END_MS = 15_000;
/** How long an ended process may take to disappear and give its handles back. */
const GONE_MS = 5000;
const POLL_MS = 50;
/** A scanner or an indexer keeps a fresh file for a moment, also after it was deleted. */
const SETTLE_MS = 1500;
/** The Restart Manager is asked about this many files that would not delete. */
const ASKED_FILES = 64;
/** A parent recorded as started this much after its child is another process with a reused PID. */
const START_TOLERANCE_MS = 1000;
/** Windows PowerShell may begin its output with one. */
const BYTE_ORDER_MARK = /^\uFEFF/;
/** Windows itself and the desktop: ending one costs more than a folder left for the next tidy. */
const PROTECTED = new Set([
	"csrss.exe",
	"dwm.exe",
	"explorer.exe",
	"fontdrvhost.exe",
	"lsass.exe",
	"memory compression",
	"msmpeng.exe",
	"registry",
	"searchindexer.exe",
	"services.exe",
	"sihost.exe",
	"smss.exe",
	"svchost.exe",
	"system",
	"system idle process",
	"wininit.exe",
	"winlogon.exe",
]);
/** The idle process and the kernel. */
const KERNEL_PIDS = 4;

export interface ProcessRow {
	/** The folder the process works in; null when Windows does not let this user read it. */
	cwd: string | null;
	exe: string | null;
	name: string;
	parent: number;
	pid: number;
	/** Start time in epoch milliseconds. */
	started: number | null;
}

export interface ProcessSurvey {
	/** Processes that keep one of the asked files open. */
	fileUsers: number[];
	processes: ProcessRow[];
}

export interface Holder {
	name: string;
	pid: number;
}

/** How the computer is asked; tests answer for it. */
export interface FolderProcesses {
	/** Ends a process and every process under it, and waits until it is gone. */
	end: (pid: number) => void;
	survey: (files: string[]) => ProcessSurvey;
}

export interface Removal {
	/** Processes that were ended to free the folder. */
	ended: Holder[];
	/** Processes that still hold the folder. */
	holders: Holder[];
	/** This command's own session is among the holders: nothing was ended. */
	own: boolean;
	removed: boolean;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function endProcess(pid: number): void {
	if (WINDOWS) {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
			cwd: import.meta.dir,
			stdio: "ignore",
			timeout: END_MS,
			windowsHide: true,
		});
	} else {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	for (let waited = 0; waited < GONE_MS && alive(pid); waited += POLL_MS) {
		sleepSync(POLL_MS);
	}
}

/**
 * One PowerShell call reads every process. Elsewhere a folder in use deletes without help, so nothing is asked.
 * A survey that fails names nobody: the folder then simply stays, as it did before.
 */
function surveyProcesses(files: string[]): ProcessSurvey {
	const nobody: ProcessSurvey = { fileUsers: [], processes: [] };
	if (!WINDOWS) {
		return nobody;
	}
	const result = spawnSync(
		"powershell",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			SCRIPT,
		],
		{
			// A helper started from inside the folder would itself be found holding it.
			cwd: import.meta.dir,
			encoding: "utf8",
			env: {
				...process.env,
				DEVHUB_HOLDERS_REQUEST: Buffer.from(
					JSON.stringify({ files: files.slice(0, ASKED_FILES) })
				).toString("base64"),
			},
			maxBuffer: 32 * 1024 * 1024,
			timeout: SURVEY_MS,
			windowsHide: true,
		}
	);
	if (result.status !== 0 || !result.stdout.trim()) {
		return nobody;
	}
	try {
		const value = JSON.parse(result.stdout.replace(BYTE_ORDER_MARK, "")) as {
			fileUsers?: unknown;
			processes?: unknown;
		};
		const rows = Array.isArray(value.processes) ? value.processes : [];
		const users = Array.isArray(value.fileUsers) ? value.fileUsers : [];
		return {
			fileUsers: users.map(Number).filter((pid) => pid > 0),
			processes: rows.map((row: Record<string, unknown>) => ({
				cwd: typeof row.cwd === "string" ? row.cwd : null,
				exe: typeof row.exe === "string" ? row.exe : null,
				name: String(row.name ?? ""),
				parent: Number(row.parent ?? 0),
				pid: Number(row.pid ?? 0),
				started: typeof row.started === "number" ? row.started : null,
			})),
		};
	} catch {
		return nobody;
	}
}

export const systemProcesses: FolderProcesses = {
	end: endProcess,
	survey: surveyProcesses,
};

const spelled = (path: string): string => {
	const absolute = resolve(path);
	return WINDOWS ? absolute.toLowerCase() : absolute;
};

function within(folder: string, path: string | null): boolean {
	if (!path) {
		return false;
	}
	const base = spelled(folder);
	const target = spelled(path);
	return (
		target === base ||
		target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
	);
}

/** Processes that work in the folder, run a program from it or keep one of the asked files open. */
export function holdersOf(folder: string, survey: ProcessSurvey): Holder[] {
	const users = new Set(survey.fileUsers);
	return survey.processes
		.filter(
			(row) =>
				row.pid > KERNEL_PIDS &&
				(within(folder, row.cwd) ||
					within(folder, row.exe) ||
					users.has(row.pid))
		)
		.map((row) => ({ name: row.name, pid: row.pid }))
		.sort((left, right) => left.pid - right.pid);
}

/** This process and the processes it was started from: the session a command runs in. */
export function ownChain(
	survey: ProcessSurvey,
	pid: number = process.pid
): Set<number> {
	const rows = new Map(survey.processes.map((row) => [row.pid, row]));
	const chain = new Set([pid]);
	let current = rows.get(pid);
	while (current) {
		const parent = rows.get(current.parent);
		if (
			!parent ||
			chain.has(parent.pid) ||
			(parent.started !== null &&
				current.started !== null &&
				parent.started > current.started + START_TOLERANCE_MS)
		) {
			break;
		}
		chain.add(parent.pid);
		current = parent;
	}
	return chain;
}

export const protectedProcess = (holder: Holder): boolean =>
	PROTECTED.has(holder.name.toLowerCase());

/**
 * Deletes what it can and returns the files that would not delete. A link is removed as a link: what it points at
 * is never entered.
 */
function removeTree(folder: string, kept: string[] = []): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(folder, { withFileTypes: true });
	} catch {
		return kept;
	}
	for (const entry of entries) {
		const path = join(folder, entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			removeTree(path, kept);
			continue;
		}
		try {
			rmSync(path, { force: true });
		} catch {
			try {
				// A read-only file refuses deletion on Windows until it is made writable.
				chmodSync(path, 0o666);
				rmSync(path, { force: true });
			} catch {
				kept.push(path);
			}
		}
	}
	try {
		rmdirSync(folder);
	} catch {
		// Still in use or not empty: the caller sees that it exists.
	}
	return kept;
}

const emptyOrGone = (folder: string): boolean => {
	try {
		return readdirSync(folder).length === 0;
	} catch {
		return true;
	}
};

/** Deletes a folder's contents, waiting out what is only held for a moment; returns the files that stayed. */
function clear(folder: string): string[] {
	let kept = removeTree(folder);
	for (
		let waited = 0;
		waited < SETTLE_MS && !emptyOrGone(folder);
		waited += POLL_MS
	) {
		sleepSync(POLL_MS);
		kept = removeTree(folder);
	}
	return kept;
}

/**
 * Removes a folder that holds no work. With `kill`, the processes that hold it are ended first, unless one of them
 * is this command's own session: ending the rest would not free the folder and only harm that session.
 */
export function removeFolder(
	folder: string,
	options: { kill: boolean; processes?: FolderProcesses; self?: number }
): Removal {
	const processes = options.processes ?? systemProcesses;
	const kept = clear(folder);
	if (!existsSync(folder)) {
		return { ended: [], holders: [], own: false, removed: true };
	}
	const survey = processes.survey(kept);
	const holders = holdersOf(folder, survey);
	const chain = ownChain(survey, options.self);
	const own = holders.some((holder) => chain.has(holder.pid));
	const endable = holders.filter((holder) => !protectedProcess(holder));
	if (own || !(options.kill && endable.length)) {
		return { ended: [], holders, own, removed: false };
	}
	for (const holder of endable) {
		processes.end(holder.pid);
	}
	// An ended process gives its handles back a moment after it disappears.
	for (
		let waited = 0;
		waited < GONE_MS && existsSync(folder);
		waited += POLL_MS
	) {
		removeTree(folder);
		if (existsSync(folder)) {
			sleepSync(POLL_MS);
		}
	}
	if (!existsSync(folder)) {
		return { ended: endable, holders: [], own: false, removed: true };
	}
	return {
		ended: endable,
		holders: holdersOf(folder, processes.survey(removeTree(folder))),
		own: false,
		removed: false,
	};
}
