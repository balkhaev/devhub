import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { sameSourcePath } from "./checkouts";
import type { Catalogue } from "./config";
import { StageProject } from "./stage";
import {
	type MachineTidy,
	type ProjectTidy,
	projectLines,
	removable,
} from "./tidy-words";

const DATA = "F:/AI";
const TRASH = /^_trash/i;

const folderOf = (catalogue: Catalogue, path: string): string =>
	// biome-ignore lint/suspicious/noTemplateCurlyInString: machine catalogue placeholder
	resolve(path.replaceAll("${code}", catalogue.code));

/** A data folder belongs to the project whose code folder has the same name. */
function dataLeftovers(
	catalogue: Catalogue,
	owners: string[],
	skip: boolean
): MachineTidy["data"] {
	const root = resolve(catalogue.data ?? DATA);
	const known = new Set(owners.map((folder) => basename(folder).toLowerCase()));
	const entries = skip || !existsSync(root) ? [] : readdirSync(root);
	return {
		root,
		trash: entries.filter((entry) => TRASH.test(entry)),
		unowned: entries.filter(
			(entry) => !(TRASH.test(entry) || known.has(entry.toLowerCase()))
		),
	};
}

/**
 * One report for the three machine folders: code, worktrees and data share the project folder name.
 * `self` adds the hub's own checkout, which its catalogue does not list.
 */
export function machineTidy(
	catalogue: Catalogue,
	options: { apply?: boolean; project?: string; self?: string } = {}
): MachineTidy {
	const projects = catalogue.projects.map((project) => ({
		folder: folderOf(catalogue, project.path),
		id: project.id,
	}));
	const { self } = options;
	if (self && !projects.some((entry) => sameSourcePath(entry.folder, self))) {
		projects.push({ folder: resolve(self), id: basename(resolve(self)) });
	}
	const report: MachineTidy = {
		busy: [],
		// One project's report leaves the shared folder to the machine-wide one.
		data: dataLeftovers(
			catalogue,
			projects.map((entry) => entry.folder),
			Boolean(options.project)
		),
		projects: [],
		skipped: [],
	};
	for (const { folder, id } of projects) {
		if (options.project && options.project !== id) {
			continue;
		}
		if (!existsSync(join(folder, ".devhub", "worktree.json"))) {
			report.skipped.push(id);
			continue;
		}
		const stage = new StageProject(folder);
		let applied: ProjectTidy["applied"];
		if (options.apply) {
			try {
				applied = stage.withLock(() => stage.tidyApply());
			} catch {
				// One project in the middle of an integration must not stop the cleanup of the others.
				report.busy.push(id);
			}
		}
		report.projects.push({
			...stage.tidy(),
			...(applied ? { applied } : {}),
			id,
		});
	}
	return report;
}

export function formatTidy(report: MachineTidy): string {
	const text: string[] = [];
	const clean: string[] = [];
	for (const project of report.projects) {
		const lines = projectLines(project);
		if (lines.length) {
			text.push(
				`${project.id} · ${project.root}`,
				...lines.map((line) => `  ${line}`)
			);
		} else {
			clean.push(project.id);
		}
	}
	if (report.data.unowned.length || report.data.trash.length) {
		text.push(report.data.root);
		if (report.data.unowned.length) {
			text.push(`  вне папок проектов: ${report.data.unowned.join(", ")}`);
		}
		if (report.data.trash.length) {
			text.push(`  ждёт удаления: ${report.data.trash.join(", ")}`);
		}
	}
	if (report.busy.length) {
		text.push(
			`заняты другой задачей, уборка не выполнена: ${report.busy.join(", ")}`
		);
	}
	if (report.projects.some((project) => removable(project) > 0)) {
		text.push("слитые ветки и записи без папок убирает tidy --apply");
	}
	if (clean.length) {
		text.push(`чисто: ${clean.join(", ")}`);
	}
	if (report.skipped.length) {
		text.push(`без политики worktree: ${report.skipped.join(", ")}`);
	}
	return `${text.join("\n")}\n`;
}
