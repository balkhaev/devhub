import { useCallback } from "react";

import type { ProjectView } from "../hub";
import { useProjectPreferences } from "./project-preferences";
import { mainFrontend } from "./project-ui";
import { isUp } from "./words";

export function FavoriteProjectButton({ project }: { project: ProjectView }) {
	const { preferences, toggleFavorite } = useProjectPreferences();
	const favorite = preferences.favorites.includes(project.id);
	const toggle = useCallback(
		() => toggleFavorite(project.id),
		[project.id, toggleFavorite]
	);
	const label = `${favorite ? "Убрать из избранного" : "В избранное"}: ${project.name}`;
	return (
		<button
			aria-label={label}
			aria-pressed={favorite}
			className="project-icon project-favorite"
			onClick={toggle}
			title={label}
			type="button"
		>
			<span aria-hidden="true">{favorite ? "★" : "☆"}</span>
		</button>
	);
}

export function ProjectCollapseButton({
	collapsed,
	controls,
	onToggle,
	project,
}: {
	collapsed: boolean;
	controls: string;
	onToggle: () => void;
	project: ProjectView;
}) {
	const label = `${collapsed ? "Развернуть" : "Свернуть"} проект: ${project.name}`;
	return (
		<button
			aria-controls={controls}
			aria-expanded={!collapsed}
			aria-label={label}
			className="project-icon project-collapse"
			onClick={onToggle}
			title={label}
			type="button"
		>
			<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
		</button>
	);
}

export function ProjectStatus({ project }: { project: ProjectView }) {
	const up = project.services.filter((service) => isUp(service.status)).length;
	const attention = project.services.filter(
		(service) =>
			service.status === "crashed" ||
			service.status === "unhealthy" ||
			service.status === "busy"
	).length;
	return (
		<span className="project-status muted small">
			{project.services.length
				? `Работают ${up} из ${project.services.length}${attention ? ` · требуют внимания: ${attention}` : ""}`
				: "Нет dev-сервисов"}
		</span>
	);
}

export function SidebarFrontendLink({ project }: { project: ProjectView }) {
	const frontend = mainFrontend(project);
	return frontend ? (
		<a
			aria-label={`Открыть приложение: ${project.name}`}
			className="project-icon side-frontend"
			href={frontend.url}
			rel="noopener"
			target="_blank"
			title={`Открыть приложение: ${project.name}`}
		>
			<span className="sr-only">Открыть приложение: {project.name}</span>
			<span aria-hidden="true">↗</span>
		</a>
	) : null;
}
