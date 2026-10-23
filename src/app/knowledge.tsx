import { type ChangeEvent, useCallback, useState } from "react";

import type { ProjectView } from "../hub";
import { CanvasBoard } from "./canvas";
import { KanbanBoard } from "./kanban";
import { useKnowledge } from "./knowledge-api";
import { ProjectNav } from "./project-nav";

export function KnowledgePage({
	project,
	section,
}: {
	project: ProjectView;
	section: "canvas" | "kanban";
}) {
	const { state, busy, error, remote, refresh, change } = useKnowledge(
		project.id
	);
	const [query, setQuery] = useState("");
	const search = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
		[]
	);
	let sync = "Готово к работе";
	if (state?.updatedAt) {
		sync = `Сохранено · ${new Date(state.updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
	}
	if (busy) {
		sync = "Сохраняю…";
	}
	return (
		<section
			aria-label={`${project.name}: база знаний`}
			className="knowledge-page"
		>
			<header className="workspace-heading">
				<div>
					<p className="eyebrow">База знаний проекта</p>
					<h1>{project.name}</h1>
					<p className="muted">
						{section === "canvas"
							? "Схемы, идеи и решения — на одной доске."
							: "От замысла до результата — вся работа проекта."}
					</p>
				</div>
				<div aria-live="polite" className="board-sync">
					<span className={`dot dot--${busy ? "starting" : "running"}`} />
					{sync}
				</div>
			</header>
			<ProjectNav id={project.id} section={section} />
			<div className="board-toolbar">
				<label className="board-search">
					<span>Поиск по доске</span>
					<input
						onChange={search}
						placeholder="Название, текст или метка…"
						type="search"
						value={query}
					/>
				</label>
				<button
					className="button"
					disabled={busy}
					onClick={refresh}
					type="button"
				>
					Обновить
				</button>
			</div>
			{remote ? (
				<div className="warn" role="status">
					Агент или другая вкладка изменили доску. Нажмите «Обновить» перед
					сохранением. Введённый текст останется в редакторе.
				</div>
			) : null}
			{error ? (
				<p className="error" role="alert">
					{error}
				</p>
			) : null}
			{state ? (
				<div aria-busy={busy} className="board-content">
					{section === "canvas" ? (
						<CanvasBoard
							busy={busy}
							canvas={state.canvas}
							change={change}
							query={query}
						/>
					) : (
						<KanbanBoard
							board={state.kanban}
							busy={busy}
							change={change}
							error={error}
							query={query}
							refresh={refresh}
						/>
					)}
				</div>
			) : (
				<p className="muted pad">Загружаю доску…</p>
			)}
		</section>
	);
}
