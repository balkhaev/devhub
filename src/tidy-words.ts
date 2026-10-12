import type { Holder } from "./holders";
import type { TidyReport } from "./stage";

/** The tidy report in words, shared by the terminal and the hub's page. */

/** A checkout nobody committed to for this long is reported as idle. */
const IDLE_DAYS = 3;
/** A leftover folder nobody used for this long is removed by itself, with the processes that hold it. */
export const IDLE_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface ProjectTidy extends TidyReport {
	applied?: {
		branches: string[];
		/** Processes that were ended because they held an emptied folder. */
		ended: Holder[];
		folders: string[];
		pruned: string[];
	};
	id: string;
}

export interface MachineTidy {
	/** Projects another stage command held while `--apply` ran: reported as they are, cleaned next time. */
	busy: string[];
	/** The shared data folder: what belongs to no project and what waits for deletion. */
	data: { root: string; trash: string[]; unowned: string[] };
	projects: ProjectTidy[];
	/** Projects without a Git workflow policy are listed, not inspected. */
	skipped: string[];
}

export const holderWords = (holders: Holder[]): string =>
	holders.map((holder) => `${holder.name} (PID ${holder.pid})`).join(", ");

/** Nobody used the folder for a day: it goes by itself, and so do the processes that hold it. */
export const idle = (folder: { used: number }, now: number): boolean =>
	now - folder.used >= IDLE_MS;

/** What `--apply` removes without asking: it holds no work, and no process uses it or nobody did for a day. */
export const removable = (project: ProjectTidy, now = Date.now()): number =>
	project.merged.length +
	project.missing.length +
	project.emptied.filter(
		(folder) => folder.holders.length === 0 || idle(folder, now)
	).length;

/** Emptied folders that processes used within the day: only `--apply --kill` ends those processes. */
export const held = (project: ProjectTidy, now = Date.now()): number =>
	project.emptied.filter(
		(folder) => folder.holders.length > 0 && !idle(folder, now)
	).length;

function idleWords(folder: { used: number }, now: number): string {
	const hours = Math.max(0, Math.floor((now - folder.used) / HOUR_MS));
	const since =
		hours > 0 ? `не использовалась ${hours} ч` : "использовалась только что";
	if (idle(folder, now)) {
		return `${since}, ждёт автоудаления`;
	}
	const left = Math.max(1, Math.ceil((folder.used + IDLE_MS - now) / HOUR_MS));
	return `${since}, автоудаление через ${left} ч`;
}

export function projectLines(project: ProjectTidy, now = Date.now()): string[] {
	const lines: string[] = [];
	if (project.applied?.branches.length) {
		lines.push(`удалено слитых веток: ${project.applied.branches.length}`);
	}
	if (project.applied?.pruned.length) {
		lines.push(`убрано записей без папок: ${project.applied.pruned.length}`);
	}
	if (project.applied?.folders.length) {
		lines.push(`убрано пустых папок: ${project.applied.folders.length}`);
	}
	if (project.applied?.ended.length) {
		lines.push(
			`завершены процессы, державшие папки: ${holderWords(project.applied.ended)}`
		);
	}
	if (project.canonicalChanges) {
		lines.push(
			`основная папка: несохранённых файлов — ${project.canonicalChanges}`
		);
	}
	if (project.stashes) {
		lines.push(`stash: ${project.stashes}`);
	}
	if (project.merged.length) {
		lines.push(`слитые ветки закрытых задач: ${project.merged.length}`);
	}
	if (project.missing.length) {
		lines.push(`записи о worktree без папок: ${project.missing.length}`);
	}
	for (const branch of project.parked) {
		lines.push(
			`отложено: ${branch.branch} · своих коммитов ${branch.ahead} · ${branch.days} дн.`
		);
	}
	for (const tree of project.working) {
		const marks = [
			`+${tree.ahead}/−${tree.behind}`,
			`изменений ${tree.changes}`,
			`${tree.days} дн.`,
			...(tree.days >= IDLE_DAYS && tree.ahead === 0 ? ["без движения"] : []),
			...(tree.outside ? ["вне папки worktree проекта"] : []),
		];
		lines.push(
			`worktree: ${tree.path} · ${tree.branch ?? "без ветки"} · ${marks.join(" · ")}`
		);
	}
	for (const folder of project.emptied) {
		lines.push(
			`пустая папка без worktree: ${folder.path}${folder.holders.length ? ` · держат: ${holderWords(folder.holders)}` : ""} · ${idleWords(folder, now)}`
		);
	}
	for (const folder of project.unregistered) {
		lines.push(`папка без worktree: ${folder}`);
	}
	return lines;
}
