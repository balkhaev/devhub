import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";

/** A lock whose holder never wrote its PID is abandoned only after this long. */
const UNREADABLE_GRACE_MS = 60_000;
/** A live PID that started this much after the lock was taken is a reused PID. */
const START_TOLERANCE_MS = 1000;
const DIGITS = /^\d+$/;
const LEGACY_PID = /^\s*(\d+)\s*$/;

export interface ProcessProbe {
	alive: (pid: number) => boolean;
	/** Process start time in epoch milliseconds, or undefined when the system does not say. */
	startedAt: (pid: number) => number | undefined;
}

interface LockHolder {
	createdAt: number;
	pid?: number;
	text: string;
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

function startedAt(pid: number): number | undefined {
	const result =
		process.platform === "win32"
			? spawnSync(
					"powershell",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
					],
					{ encoding: "utf8", timeout: 15_000, windowsHide: true }
				)
			: spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
					encoding: "utf8",
					env: { ...process.env, LC_ALL: "C" },
					timeout: 15_000,
				});
	if (result.status !== 0 || !result.stdout.trim()) {
		return;
	}
	const text = result.stdout.trim();
	const value = DIGITS.test(text) ? Number(text) : Date.parse(text);
	return Number.isFinite(value) ? value : undefined;
}

export const systemProbe: ProcessProbe = { alive, startedAt };

function readHolder(file: string): LockHolder | undefined {
	let text: string;
	let modified: number;
	try {
		text = readFileSync(file, "utf8");
		modified = statSync(file).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	// Older DevHub versions wrote only the PID; the file time then marks when it was taken.
	const legacy = LEGACY_PID.exec(text);
	if (legacy) {
		return { createdAt: modified, pid: Number(legacy[1]), text };
	}
	try {
		const value = JSON.parse(text) as { createdAt?: unknown; pid?: unknown };
		if (
			Number.isInteger(value.pid) &&
			(value.pid as number) > 0 &&
			typeof value.createdAt === "number"
		) {
			return { createdAt: value.createdAt, pid: value.pid as number, text };
		}
	} catch {
		// Interrupted between creation and the PID write.
	}
	return { createdAt: modified, text };
}

/** Why the holder can no longer own the lock, or undefined while it may still be alive. */
function staleReason(
	holder: LockHolder,
	probe: ProcessProbe
): string | undefined {
	if (holder.pid === undefined) {
		return Date.now() - holder.createdAt > UNREADABLE_GRACE_MS
			? "блокировка без PID"
			: undefined;
	}
	if (holder.pid === process.pid) {
		return;
	}
	if (!probe.alive(holder.pid)) {
		return `PID ${holder.pid} завершён`;
	}
	// An unknown start time keeps the lock: only a provably newer process is a reused PID.
	const started = probe.startedAt(holder.pid);
	if (
		started !== undefined &&
		started > holder.createdAt + START_TOLERANCE_MS
	) {
		return `PID ${holder.pid} занят процессом, запущенным после блокировки`;
	}
}

function create(file: string, text: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw error;
	}
	try {
		writeFileSync(fd, text);
	} catch (error) {
		closeSync(fd);
		rmSync(file, { force: true });
		throw error;
	}
	closeSync(fd);
	return true;
}

function busy(label: string, file: string, holder?: LockHolder): Error {
	return new Error(
		`${label}: ${file}${holder?.pid === undefined ? "" : ` (PID ${holder.pid})`}`
	);
}

/**
 * Exclusive cross-process lock file. A lock left by a killed process is replaced only when its
 * holder is provably gone; a lock whose holder may still run is never removed.
 */
export function acquireFileLock(
	file: string,
	label: string,
	probe: ProcessProbe = systemProbe
): () => void {
	const text = `${JSON.stringify({ createdAt: Date.now(), nonce: randomUUID(), pid: process.pid })}\n`;
	const release = () => {
		// Never delete a lock that someone else owns now.
		if (readHolder(file)?.text === text) {
			rmSync(file, { force: true });
		}
	};
	if (create(file, text)) {
		return release;
	}
	const holder = readHolder(file);
	if (!holder) {
		// The holder released between our attempt and the read; try once more.
		if (create(file, text)) {
			return release;
		}
		throw busy(label, file);
	}
	const reason = staleReason(holder, probe);
	if (!reason) {
		throw busy(label, file, holder);
	}
	// Recoverers are serialised: a second one sees the replaced lock and its live holder.
	const guard = `${file}.recover`;
	if (!create(guard, text)) {
		// Replacing a guard would let two recoverers both take the lock; a dead one is reported.
		const recoverer = readHolder(guard);
		const gone = recoverer && staleReason(recoverer, probe);
		throw busy(
			gone
				? `${label}; восстановление блокировки прервано (${gone}), проверьте, что stage-процессов нет, и удалите`
				: `${label}; блокировку уже восстанавливает другой процесс`,
			guard,
			recoverer
		);
	}
	try {
		if (readHolder(file)?.text !== holder.text) {
			throw busy(label, file, readHolder(file));
		}
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, text);
		renameSync(temporary, file);
	} finally {
		rmSync(guard, { force: true });
	}
	process.stderr.write(
		`stage: снята устаревшая блокировка ${file}: ${reason}\n`
	);
	return release;
}
