import { useCallback, useEffect, useState } from "react";

import type { ProjectView } from "../hub";
import { held, type MachineTidy, projectLines, removable } from "../tidy-words";
import { readHub, sendHub } from "./api";
import { projectRoute } from "./project-ui";

/** What finished work left in code, worktrees and data: nothing should stay here for long. */

function useTidy(): {
	apply: () => void;
	busy: boolean;
	/** Also ends the processes that hold emptied folders. */
	free: () => void;
	error: string | null;
	refresh: () => void;
	report: MachineTidy | null;
} {
	const [report, setReport] = useState<MachineTidy | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(true);
	const run = useCallback((work: () => Promise<MachineTidy>) => {
		setBusy(true);
		setError(null);
		work()
			.then(setReport)
			.catch((reason: unknown) => setError((reason as Error).message))
			.finally(() => setBusy(false));
	}, []);
	const refresh = useCallback(
		() => run(() => readHub<MachineTidy>("/api/tidy")),
		[run]
	);
	const apply = useCallback(
		() => run(() => sendHub<MachineTidy>("/api/tidy", {})),
		[run]
	);
	const free = useCallback(
		() => run(() => sendHub<MachineTidy>("/api/tidy", { kill: true })),
		[run]
	);
	useEffect(refresh, [refresh]);
	return { apply, busy, error, free, refresh, report };
}

function DataCard({ data }: { data: MachineTidy["data"] }) {
	if (!(data.unowned.length || data.trash.length)) {
		return null;
	}
	return (
		<section className="card">
			<div className="card__head">
				<div className="card__title">
					<h2>{data.root}</h2>
					<span className="muted small">
						данные: папка проекта называется так же, как в code
					</span>
				</div>
			</div>
			<ul className="tidy-list">
				{data.unowned.length ? (
					<li>вне папок проектов: {data.unowned.join(", ")}</li>
				) : null}
				{data.trash.length ? (
					<li>ждёт удаления: {data.trash.join(", ")}</li>
				) : null}
			</ul>
		</section>
	);
}

export function TidyPage({ projects }: { projects: ProjectView[] }) {
	const { apply, busy, error, free, refresh, report } = useTidy();
	const names = new Map(projects.map((project) => [project.id, project.name]));
	const listed = (report?.projects ?? []).map((project) => ({
		lines: projectLines(project),
		project,
	}));
	const clean = listed.filter((entry) => entry.lines.length === 0);
	const pending = listed.reduce(
		(count, entry) => count + removable(entry.project),
		0
	);
	const occupied = listed.reduce(
		(count, entry) => count + held(entry.project),
		0
	);
	return (
		<div className="overview">
			<header className="prod-head">
				<div>
					<h1>Порядок</h1>
					<p className="muted">
						Что осталось после задач: ветки, worktree, несохранённые правки и
						данные вне папок проектов. Пустая страница — всё убрано.
					</p>
				</div>
				<button
					className="button"
					disabled={busy}
					onClick={refresh}
					type="button"
				>
					{busy ? "Проверяю…" : "Обновить"}
				</button>
				{pending ? (
					<button
						className="button button--primary"
						disabled={busy}
						onClick={apply}
						title="Слитые ветки закрытых задач, записи о worktree без папок и пустые папки: в них нет работы"
						type="button"
					>
						Убрать лишнее: {pending}
					</button>
				) : null}
				{occupied ? (
					<button
						className="button"
						disabled={busy}
						onClick={free}
						title="Завершит процессы, которые держат пустые папки закрытых задач (они названы в списке), и удалит папки. Сеанс агента, открытый в такой папке, закроется"
						type="button"
					>
						Освободить занятые папки: {occupied}
					</button>
				) : null}
			</header>
			{error ? <p className="note">{error}</p> : null}
			{report || error ? null : (
				<p className="muted">Читаю Git всех проектов…</p>
			)}
			<div className="cards cards--prod">
				{listed
					.filter((entry) => entry.lines.length > 0)
					.map(({ lines, project }) => (
						<section className="card" key={project.id}>
							<div className="card__head">
								<div className="card__title">
									<h2>
										<a href={`#/${projectRoute(project.id)}`}>
											{names.get(project.id) ?? project.id}
										</a>
									</h2>
									<span className="muted small">{project.root}</span>
								</div>
							</div>
							<ul className="tidy-list">
								{lines.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</section>
					))}
				{report ? <DataCard data={report.data} /> : null}
			</div>
			{clean.length ? (
				<p className="muted">
					Чисто: {clean.map((entry) => entry.project.id).join(", ")}
				</p>
			) : null}
			{report?.busy.length ? (
				<p className="note">
					Заняты другой задачей, уборка не выполнена: {report.busy.join(", ")}.
					Повторите позже.
				</p>
			) : null}
			{report?.skipped.length ? (
				<p className="muted">
					Без политики worktree: {report.skipped.join(", ")}
				</p>
			) : null}
		</div>
	);
}
