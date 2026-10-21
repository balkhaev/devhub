import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { ProjectView, ServiceStatus, ServiceView } from "../hub";
import { act } from "./api";
import { useConfirm } from "./confirm";
import { mainFrontend, projectRoute } from "./project-ui";
import { cx, isLive, projectsWord, STATUS_SHORT } from "./words";

/** Projects that are on the machine now, with a way to open, restart or stop each one. */

const TONE_ORDER: ServiceStatus[] = [
	"unhealthy",
	"starting",
	"external",
	"running",
];

export function liveServices(project: ProjectView): ServiceView[] {
	return project.services.filter((service) => isLive(service.status));
}

export function runningProjects(projects: ProjectView[]): ProjectView[] {
	return projects.filter((project) => liveServices(project).length > 0);
}

function toneOf(services: ServiceView[]): ServiceStatus {
	for (const status of TONE_ORDER) {
		if (services.some((service) => service.status === status)) {
			return status;
		}
	}
	return "running";
}

function foreignLines(services: ServiceView[]): string[] {
	return services
		.filter((service) => !service.managed)
		.map((service) => {
			const where = service.owner ? `\n${service.owner.label}` : "";
			return `${service.name} запущен не из пульта:${where}`;
		});
}

/** What to ask before stopping a project that was not started from the hub, or null. */
export function stopQuestion(
	project: ProjectView,
	services: ServiceView[]
): string | null {
	const lines = foreignLines(services);
	if (lines.length === 0) {
		return null;
	}
	return `${lines.join("\n\n")}\n\nОстановить ${project.name} и всё, что эти процессы запустили?`;
}

/** What to ask before the hub takes over a project it did not start, or null. */
export function restartQuestion(
	project: ProjectView,
	services: ServiceView[]
): string | null {
	const lines = foreignLines(services);
	if (lines.length === 0) {
		return null;
	}
	return `${lines.join("\n\n")}\n\nПульт остановит их и запустит заново сам. Перезапустить ${project.name}?`;
}

function serviceLabel(service: ServiceView): string {
	const port = service.port ? `:${service.port}` : "";
	const state =
		service.status === "running" || service.status === "external"
			? ""
			: ` · ${STATUS_SHORT[service.status]}`;
	return `${service.name}${port}${state}`;
}

function OpenProject({
	onNavigate,
	project,
}: {
	onNavigate?: () => void;
	project: ProjectView;
}) {
	const frontend = mainFrontend(project);
	const live = new Set(liveServices(project).map((service) => service.key));
	const page = frontend && live.has(frontend.service.key) ? frontend : null;
	if (page) {
		return (
			<a
				className="button button--small button--primary"
				href={page.url}
				onClick={onNavigate}
				rel="noopener"
				target="_blank"
				title={`${page.label} · ${page.url}`}
			>
				Открыть
			</a>
		);
	}
	return (
		<a
			className="button button--small button--primary"
			href={`#/${projectRoute(project.id)}`}
			onClick={onNavigate}
			title="Страница проекта в пульте"
		>
			Открыть
		</a>
	);
}

function RunningProjectRow({
	onNavigate,
	project,
}: {
	onNavigate?: () => void;
	project: ProjectView;
}) {
	const live = liveServices(project);
	const restartable = live.some((service) => service.canStart);
	const [pending, setPending] = useState<"restart" | "stop" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirm, dialog] = useConfirm();
	const restartPath = `/api/projects/${encodeURIComponent(project.id)}/restart`;
	const stop = useCallback(async () => {
		const targets = liveServices(project);
		const ask = stopQuestion(project, targets);
		if (ask && !(await confirm(ask))) {
			return;
		}
		setPending("stop");
		const errors = (
			await Promise.all(
				targets.map((service) => act(`/api/services/${service.key}/stop`))
			)
		).filter((entry) => entry !== null);
		setError(errors.length > 0 ? errors.join("\n") : null);
		setPending(null);
	}, [confirm, project]);
	const restart = useCallback(async () => {
		const targets = liveServices(project).filter((service) => service.canStart);
		const ask = restartQuestion(project, targets);
		if (ask && !(await confirm(ask))) {
			return;
		}
		setPending("restart");
		setError(await act(restartPath));
		setPending(null);
	}, [confirm, project, restartPath]);
	const busy = pending !== null;
	return (
		<li className="running-project">
			<div className="running-project__main">
				<a
					className="running-project__name"
					href={`#/${projectRoute(project.id)}`}
					onClick={onNavigate}
				>
					<span className={cx("dot", `dot--${toneOf(live)}`)} />
					<span className="running-project__title">{project.name}</span>
				</a>
				<span
					className="running-project__services muted"
					title={live.map(serviceLabel).join(" · ")}
				>
					{live.map(serviceLabel).join(" · ")}
				</span>
			</div>
			<div className="running-project__actions">
				<OpenProject onNavigate={onNavigate} project={project} />
				{restartable ? (
					<button
						className="button button--small"
						data-path={restartPath}
						disabled={busy}
						onClick={restart}
						title="Перезапустить"
						type="button"
					>
						{pending === "restart" ? "…" : "Заново"}
					</button>
				) : null}
				<button
					className="button button--small"
					disabled={busy}
					onClick={stop}
					title="Остановить"
					type="button"
				>
					{pending === "stop" ? "…" : "Стоп"}
				</button>
			</div>
			{error ? (
				<p className="running-project__error" role="alert">
					{error}
				</p>
			) : null}
			{dialog}
		</li>
	);
}

export function RunningProjectsList({
	onNavigate,
	projects,
}: {
	onNavigate?: () => void;
	projects: ProjectView[];
}) {
	const running = runningProjects(projects);
	if (running.length === 0) {
		return <p className="muted running-projects__empty">Ничего не запущено.</p>;
	}
	return (
		<ul className="running-projects">
			{running.map((project) => (
				<RunningProjectRow
					key={project.id}
					onNavigate={onNavigate}
					project={project}
				/>
			))}
		</ul>
	);
}

function menuLabel(count: number): string {
	return count === 0 ? "Ничего не запущено" : `Запущено ${projectsWord(count)}`;
}

/** The header's list: the same projects, opened from any page. */
export function RunningProjectsMenu({ projects }: { projects: ProjectView[] }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const listId = useId();
	const running = runningProjects(projects);
	const live = running.flatMap(liveServices);
	const toggle = useCallback(() => setOpen((current) => !current), []);
	const close = useCallback(() => setOpen(false), []);
	const label = menuLabel(running.length);
	useEffect(() => {
		if (!open) {
			return;
		}
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest("dialog")) {
				return;
			}
			if (
				event.target instanceof Node &&
				!root.current?.contains(event.target)
			) {
				setOpen(false);
			}
		};
		const escapeKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest("dialog")) {
				return;
			}
			if (event.key === "Escape") {
				setOpen(false);
				button.current?.focus();
			}
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escapeKey);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escapeKey);
		};
	}, [open]);
	return (
		<div className="running-widget" ref={root}>
			<button
				aria-controls={open ? listId : undefined}
				aria-expanded={open}
				aria-label={`Запущенные проекты. ${label}.`}
				className="running-status"
				onClick={toggle}
				ref={button}
				title={
					live.length > 0
						? live.map((service) => service.name).join(", ")
						: "Нет запущенных проектов"
				}
				type="button"
			>
				<span
					aria-hidden="true"
					className={cx(
						"dot",
						`dot--${live.length > 0 ? toneOf(live) : "stopped"}`
					)}
				/>
				<span className="running-status__label">{label}</span>
				<span aria-hidden="true" className="running-status__chevron">
					{open ? "▴" : "▾"}
				</span>
			</button>
			{open ? (
				<section
					aria-label="Запущенные проекты"
					className="running-popover"
					id={listId}
				>
					<div className="queue-popover__head">
						<h2>Запущенные проекты</h2>
					</div>
					<RunningProjectsList onNavigate={close} projects={projects} />
				</section>
			) : null}
		</div>
	);
}
