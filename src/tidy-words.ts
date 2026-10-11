import type { TidyReport } from "./stage";

/** The tidy report in words, shared by the terminal and the hub's page. */

/** A checkout nobody committed to for this long is reported as idle. */
const IDLE_DAYS = 3;

export interface ProjectTidy extends TidyReport {
	applied?: { branches: string[]; pruned: string[] };
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

/** What `--apply` removes without asking: it holds no work. */
export const removable = (project: ProjectTidy): number =>
	project.merged.length + project.missing.length;

export function projectLines(project: ProjectTidy): string[] {
	const lines: string[] = [];
	if (project.applied?.branches.length) {
		lines.push(`удалено слитых веток: ${project.applied.branches.length}`);
	}
	if (project.applied?.pruned.length) {
		lines.push(`убрано записей без папок: ${project.applied.pruned.length}`);
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
	for (const folder of project.unregistered) {
		lines.push(`папка без worktree: ${folder}`);
	}
	return lines;
}
