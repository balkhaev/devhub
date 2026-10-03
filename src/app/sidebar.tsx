import { type MouseEvent, useCallback } from "react";

import type { HubView, ProjectView, ServiceView } from "../hub";
import {
	FavoriteProjectButton,
	ProjectCollapseButton,
	ProjectStatus,
	SidebarFrontendLink,
} from "./project-preference-controls";
import { favoriteProjects, useProjectPreferences } from "./project-preferences";
import { projectRoute } from "./project-ui";
import { composeStatus, cx, STATUS_SHORT } from "./words";

/** Every project and its services with their state; the overview at the top, Docker at the bottom. */

function ServiceRow({
	onOpen,
	selected,
	service,
}: {
	onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
	selected: boolean;
	service: ServiceView;
}) {
	return (
		<li>
			<button
				aria-current={selected ? "true" : undefined}
				className={cx("side-item", selected && "side-item--selected")}
				data-key={service.key}
				onClick={onOpen}
				title={service.description ?? service.name}
				type="button"
			>
				<span className={cx("dot", `dot--${service.status}`)} />
				<span className="side-item__name">{service.name}</span>
				<span className="side-item__meta">
					{service.port ?? ""}
					{service.status === "stopped"
						? ""
						: ` · ${STATUS_SHORT[service.status]}`}
				</span>
			</button>
		</li>
	);
}

function ProjectGroup({
	onOpen,
	project,
	selected,
}: {
	onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
	project: ProjectView;
	selected: string | null;
}) {
	const { preferences, toggleCollapse } = useProjectPreferences();
	const collapsed = preferences.collapsed.sidebar.includes(project.id);
	const details = `sidebar-project-${project.id}`;
	const collapse = useCallback(
		() => toggleCollapse("sidebar", project.id),
		[project.id, toggleCollapse]
	);
	const currentService = project.services.find(
		(service) => service.key === selected
	);
	return (
		<section className="side-group">
			<div className="side-group__head">
				<h3 className="side-group__title">
					<button
						aria-current={
							selected === projectRoute(project.id) ? "true" : undefined
						}
						className={cx(
							"side-project",
							(selected === projectRoute(project.id) ||
								Boolean(currentService)) &&
								"side-project--selected"
						)}
						data-key={projectRoute(project.id)}
						onClick={onOpen}
						type="button"
					>
						{project.name}
					</button>
				</h3>
				<div className="side-group__actions">
					<SidebarFrontendLink project={project} />
					<FavoriteProjectButton project={project} />
					<ProjectCollapseButton
						collapsed={collapsed}
						controls={details}
						onToggle={collapse}
						project={project}
					/>
				</div>
			</div>
			<div className="side-group__status">
				<ProjectStatus project={project} />
				{collapsed && currentService ? (
					<span className="side-group__current muted small">
						Открыт: {currentService.name}
					</span>
				) : null}
			</div>
			<ul className="side-group__list" hidden={collapsed} id={details}>
				{collapsed
					? null
					: project.services.map((service) => (
							<ServiceRow
								key={service.key}
								onOpen={onOpen}
								selected={service.key === selected}
								service={service}
							/>
						))}
			</ul>
		</section>
	);
}

export function Sidebar({
	onOpen,
	selected,
	view,
}: {
	onOpen: (key: string | null) => void;
	selected: string | null;
	view: HubView | null;
}) {
	const { preferences } = useProjectPreferences();
	const open = useCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			onOpen(event.currentTarget.dataset.key ?? null);
		},
		[onOpen]
	);
	const home = useCallback(() => onOpen(null), [onOpen]);
	const running = (view?.docker.projects ?? []).filter(
		(project) => project.ready
	);
	return (
		<nav aria-label="Проекты и сервисы" className="sidebar">
			<button
				aria-current={selected ? undefined : "true"}
				className={cx(
					"side-item",
					"side-item--home",
					!selected && "side-item--selected"
				)}
				onClick={home}
				type="button"
			>
				Обзор
			</button>
			<button
				aria-current={selected === "ai" ? "true" : undefined}
				className={cx(
					"side-item",
					"side-item--home",
					selected === "ai" && "side-item--selected"
				)}
				data-key="ai"
				onClick={open}
				type="button"
			>
				Claude и Codex
			</button>
			{favoriteProjects(view?.projects ?? [], preferences.favorites).map(
				(project) => (
					<ProjectGroup
						key={project.id}
						onOpen={open}
						project={project}
						selected={selected}
					/>
				)
			)}
			{view?.docker.available ? (
				<section className="side-group">
					<h3 className="side-group__title">
						Docker
						<span className="side-group__count">
							{running.length}/{view.docker.projects.length}
						</span>
					</h3>
					<ul className="side-group__list">
						{view.docker.projects.map((project) => {
							const up = project.containers.filter(
								(container) => container.running
							);
							const status = composeStatus(project);
							const key = `docker/${project.name}`;
							return (
								<li key={project.name}>
									<button
										aria-current={key === selected ? "true" : undefined}
										className={cx(
											"side-item",
											key === selected && "side-item--selected"
										)}
										data-key={key}
										onClick={open}
										type="button"
									>
										<span className={cx("dot", `dot--${status}`)} />
										<span className="side-item__name">{project.name}</span>
										<span className="side-item__meta">
											{up.length}/{project.containers.length}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
		</nav>
	);
}
