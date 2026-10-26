import {
	type ChangeEvent,
	type MouseEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { HubView, ProjectView } from "../hub";
import { Overview } from "./overview";
import { FavoriteProjectButton } from "./project-preference-controls";
import { useProjectPreferences } from "./project-preferences";
import { projectRoute } from "./project-ui";
import {
	findProjects,
	type ProjectFilter,
	projectDestination,
	projectHasAttention,
	projectIdentity,
	projectIsRunning,
} from "./start-page-model";
import { cx } from "./words";

function SearchIcon() {
	return (
		<svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
			<title>Поиск</title>
			<circle cx="10.75" cy="10.75" r="6.75" />
			<path d="m16 16 4.5 4.5" />
		</svg>
	);
}

function Clock() {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			setNow(new Date());
			timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
		};
		tick();
		return () => clearTimeout(timer);
	}, []);
	return (
		<div className="start-clock">
			<time dateTime={now.toISOString()}>
				{now.toLocaleTimeString("ru-RU", {
					hour: "2-digit",
					minute: "2-digit",
				})}
			</time>
			<span>
				{now.toLocaleDateString("ru-RU", {
					day: "numeric",
					month: "long",
					weekday: "long",
				})}
			</span>
		</div>
	);
}

function ProjectMark({ project }: { project: ProjectView }) {
	const { initials, tone } = projectIdentity(project);
	return (
		<span aria-hidden="true" className={`project-mark project-mark--${tone}`}>
			{initials}
		</span>
	);
}

function QuickAccess({ projects }: { projects: ProjectView[] }) {
	const { preferences } = useProjectPreferences();
	const favorites = projects.filter((project) =>
		preferences.favorites.includes(project.id)
	);
	const selected =
		favorites.length > 0
			? favorites
			: projects.filter(projectIsRunning).slice(0, 6);
	if (selected.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby="quick-access-title" className="quick-access">
			<div className="start-section-heading">
				<h2 id="quick-access-title">
					{favorites.length > 0 ? "Избранное" : "Продолжить работу"}
				</h2>
				<span>
					{favorites.length > 0
						? "Всегда под рукой"
						: "Добавляйте проекты сюда с помощью ☆"}
				</span>
			</div>
			<ul className="quick-access__list">
				{selected.map((project) => {
					const destination = projectDestination(project);
					return (
						<li key={project.id}>
							<a
								className="quick-link"
								href={destination.url}
								rel={destination.external ? "noopener" : undefined}
								target={destination.external ? "_blank" : undefined}
								title={`${destination.external ? "Открыть приложение" : "Открыть проект"}: ${project.name}`}
							>
								<ProjectMark project={project} />
								<span>{project.name}</span>
								<span aria-hidden="true" className="quick-link__arrow">
									{destination.external ? "↗" : "→"}
								</span>
							</a>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function StartProjectCard({ project }: { project: ProjectView }) {
	const destination = projectDestination(project);
	const attention = projectHasAttention(project);
	const running = projectIsRunning(project);
	const ready = project.services.some(
		(service) => service.status === "running" || service.status === "external"
	);
	const waiting = running ? "Запускается" : "Не запущен";
	const availability = ready ? "Работает" : waiting;
	const status = attention ? "Требует внимания" : availability;
	return (
		<article className="project-tile" data-project-id={project.id}>
			<FavoriteProjectButton project={project} />
			<a
				aria-label={`${destination.external ? "Открыть приложение" : "Открыть проект"}: ${project.name}`}
				className="project-tile__open"
				href={destination.url}
				rel={destination.external ? "noopener" : undefined}
				target={destination.external ? "_blank" : undefined}
			>
				<ProjectMark project={project} />
				<h3>{project.name}</h3>
				<p className="project-tile__description">
					{project.description || "Проект в вашем рабочем пространстве"}
				</p>
				<div className="project-tile__bottom">
					<span
						className={cx(
							"project-tile__status",
							attention && "project-tile__status--attention",
							running && !attention && "project-tile__status--running"
						)}
					>
						<span aria-hidden="true" />
						{project.services.length > 0 ? status : "Рабочее пространство"}
					</span>
					<span aria-hidden="true" className="project-tile__launch">
						{destination.external ? "Открыть ↗" : "К проекту →"}
					</span>
				</div>
			</a>
			<a
				aria-label={`Управление проектом: ${project.name}`}
				className="project-tile__manage"
				href={`#/${projectRoute(project.id)}`}
				title={`Управление проектом: ${project.name}`}
			>
				<span className="sr-only">Управление проектом: {project.name}</span>
				<span aria-hidden="true">···</span>
			</a>
		</article>
	);
}

function ProjectSearch({
	onChange,
	onClear,
	query,
}: {
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
	onClear: () => void;
	query: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const shortcut = (event: KeyboardEvent) => {
			const { target } = event;
			if (
				event.key !== "/" ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				(target instanceof HTMLElement &&
					(target.isContentEditable ||
						target.closest("input, textarea, select, dialog")))
			) {
				return;
			}
			event.preventDefault();
			input.current?.focus();
		};
		document.addEventListener("keydown", shortcut);
		return () => document.removeEventListener("keydown", shortcut);
	}, []);
	const keyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Escape") {
				onClear();
			}
		},
		[onClear]
	);
	return (
		<search className="project-search">
			<SearchIcon />
			<input
				aria-label="Поиск проектов и сервисов"
				autoComplete="off"
				onChange={onChange}
				onKeyDown={keyDown}
				placeholder="Найти проект, сервис или инструмент…"
				ref={input}
				spellCheck={false}
				type="search"
				value={query}
			/>
			{query ? (
				<button aria-label="Очистить поиск" onClick={onClear} type="button">
					<span aria-hidden="true">×</span>
				</button>
			) : (
				<kbd>/</kbd>
			)}
		</search>
	);
}

export function StartPage({
	onDeleted,
	view,
}: {
	onDeleted: (id: string) => void;
	view: HubView;
}) {
	const { preferences } = useProjectPreferences();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<ProjectFilter>("all");
	const changeQuery = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
		[]
	);
	const clearQuery = useCallback(() => setQuery(""), []);
	const reset = useCallback(() => {
		setQuery("");
		setFilter("all");
	}, []);
	const chooseFilter = useCallback((event: MouseEvent<HTMLButtonElement>) => {
		setFilter(event.currentTarget.dataset.filter as ProjectFilter);
	}, []);
	const filters: { count: number; id: ProjectFilter; label: string }[] = [
		{ count: view.projects.length, id: "all", label: "Все проекты" },
		{
			count: view.projects.filter((project) =>
				preferences.favorites.includes(project.id)
			).length,
			id: "favorites",
			label: "Избранное",
		},
		{
			count: view.projects.filter(projectIsRunning).length,
			id: "running",
			label: "Работают",
		},
		{
			count: view.projects.filter(projectHasAttention).length,
			id: "attention",
			label: "Требуют внимания",
		},
	];
	const projects = findProjects(
		view.projects,
		preferences.favorites,
		query,
		filter
	);
	let emptyDescription = "Попробуйте другой запрос или выберите все проекты.";
	if (view.projects.length === 0) {
		emptyDescription =
			"Создайте проект, чтобы собрать свои инструменты в одном месте.";
	} else if (filter === "favorites" && !query) {
		emptyDescription =
			"Нажмите ☆ на карточке проекта, чтобы добавить его в избранное.";
	}
	return (
		<div className="start-page">
			<header className="start-hero">
				<div>
					<p className="start-eyebrow">
						<span aria-hidden="true" /> Ваше рабочее пространство
					</p>
					<h1>С чего начнём?</h1>
					<p className="start-hero__description">
						Ваши проекты и инструменты. На одной странице.
					</p>
				</div>
				<Clock />
			</header>
			<ProjectSearch
				onChange={changeQuery}
				onClear={clearQuery}
				query={query}
			/>
			<QuickAccess projects={view.projects} />
			<section aria-label="Каталог проектов" className="start-catalog">
				<div className="start-catalog__toolbar">
					<fieldset className="project-filters">
						<legend className="sr-only">Фильтр проектов</legend>
						{filters.map((entry) => (
							<button
								aria-pressed={filter === entry.id}
								className={cx(
									"project-filter",
									filter === entry.id && "project-filter--active"
								)}
								data-filter={entry.id}
								key={entry.id}
								onClick={chooseFilter}
								type="button"
							>
								{entry.label} <span>{entry.count}</span>
							</button>
						))}
					</fieldset>
					<a className="start-add" href="#/new">
						<span aria-hidden="true">+</span> Новый проект
					</a>
				</div>
				{query || filter !== "all" ? (
					<p className="start-results" role="status">
						Найдено проектов: {projects.length}
					</p>
				) : null}
				{projects.length > 0 ? (
					<div className="project-grid">
						{projects.map((project) => (
							<StartProjectCard key={project.id} project={project} />
						))}
					</div>
				) : (
					<div className="start-empty">
						<SearchIcon />
						<h2>
							{view.projects.length === 0
								? "Здесь начнётся ваш следующий проект"
								: "Проектов не найдено"}
						</h2>
						<p>{emptyDescription}</p>
						{view.projects.length > 0 ? (
							<button className="button" onClick={reset} type="button">
								Показать все проекты
							</button>
						) : (
							<a className="button" href="#/new">
								Создать проект
							</a>
						)}
					</div>
				)}
			</section>
			<details className="start-tools">
				<summary>
					<span aria-hidden="true" className="start-tools__icon">
						⌘
					</span>
					<span>Управление и диагностика</span>
					<span className="start-tools__hint">
						Сервисы · очередь · Docker · порты
					</span>
					<span aria-hidden="true" className="start-tools__chevron">
						⌄
					</span>
				</summary>
				<Overview onDeleted={onDeleted} view={view} />
			</details>
			<footer className="start-footer">
				<span>
					DevHub <span aria-hidden="true">/</span> Локальное рабочее
					пространство
				</span>
				<span>
					<kbd>/</kbd> поиск <span aria-hidden="true">·</span> <kbd>Esc</kbd>{" "}
					очистить
				</span>
			</footer>
		</div>
	);
}
