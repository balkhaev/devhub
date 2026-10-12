import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Whose `%LOCALAPPDATA%` this process works in. A packaged desktop app (Claude, Codex) gives every process started
 * from it, however deep, a private copy laid over the real folder: a new file lands in
 * `Packages\<package>\LocalCache\Local`, and a file already there hides the real one. A hub living in such a view
 * hands it to every service it starts, and their state under AppData splits from what the same services see when
 * started from the desktop (a database opened with another view's stale write-ahead log is damaged). Windows names
 * no package for such a process, so the folder itself is asked: a file created under `%LOCALAPPDATA%` that turns up
 * in a package's private folder was redirected there.
 */

/** Where a package keeps its private copy of `%LOCALAPPDATA%`. */
const privateCopy = (local: string, owner: string): string =>
	join(local, "Packages", owner, "LocalCache", "Local");

/** The package whose private folder holds the file of this name; null when none does. */
export function probeOwner(local: string, name: string): string | null {
	let owners: string[];
	try {
		owners = readdirSync(join(local, "Packages"));
	} catch {
		// No packaged apps at all.
		return null;
	}
	return (
		owners.find((owner) => existsSync(join(privateCopy(local, owner), name))) ??
		null
	);
}

/** The package whose private copy of `%LOCALAPPDATA%` this process works in; null when it sees the real folder. */
export function appViewOwner(local = process.env.LOCALAPPDATA): string | null {
	if (!local) {
		return null;
	}
	const name = `devhub-view-${process.pid}-${randomBytes(6).toString("hex")}.probe`;
	const probe = join(local, name);
	try {
		closeSync(openSync(probe, "wx"));
	} catch {
		// Nothing can be created here, so nothing of this process can land in a private copy either.
		return null;
	}
	try {
		return probeOwner(local, name);
	} finally {
		rmSync(probe, { force: true });
	}
}

/** Why the hub does not run in an app's private view, and how to start it instead. */
export function appViewRefusal(owner: string): string {
	return [
		`Пульт не запускается из приложения ${owner}: запущенные из него процессы видят свою копию %LOCALAPPDATA%`,
		`(Packages\\${owner}\\LocalCache\\Local), и сервисы пульта разошлись бы в данных с теми же сервисами,`,
		"запущенными с рабочего стола. Запустите пульт значком в трее, ярлыком «Пульт» или командой bun run open:",
		"они поднимают его вне приложения.",
	].join(" ");
}
