import { useCallback, useEffect } from "react";

import { useHub, useRoute } from "./api";
import { CreatePage } from "./create";
import { HeaderStatus } from "./header-status";
import { KnowledgePage } from "./knowledge";
import { ComposeCard } from "./overview";
import { ProjectPage } from "./project";
import { ProjectPreferencesProvider } from "./project-preferences";
import { projectRoute } from "./project-ui";
import { QueueProvider } from "./queue";
import { RunningProjectsMenu } from "./running-projects";
import { ServicePage } from "./service";
import { SettingsPage } from "./settings";
import { Sidebar } from "./sidebar";
import { StartPage } from "./start-page";

/**
 * The hub: every local project's dev servers on the left, the chosen one's pages, log and details on the right, and
 * an overview of what runs, Docker and every listening port. It follows the computer live.
 */

const STATIC_ROUTES = new Set([
	"new",
	"prod",
	"tidy",
	"settings",
	"settings/prod",
	"settings/tidy",
	"settings/mcp",
]);

const reloadPage = () => window.location.reload();

function ReloadNotice() {
	return (
		<aside aria-label="Обновление пульта" className="reload-notice">
			<div role="status">
				<strong>Пульт перезапущен</strong>
				<p className="muted">
					Перезагрузите страницу, чтобы открыть обновлённый интерфейс.
				</p>
			</div>
			<button className="button" onClick={reloadPage} type="button">
				Перезагрузить страницу
			</button>
		</aside>
	);
}

function Main({
	onDeleted,
	route,
	view,
}: {
	onDeleted: (id: string) => void;
	route: string | null;
	view: NonNullable<ReturnType<typeof useHub>["view"]>;
}) {
	if (route === "new") {
		return <CreatePage />;
	}
	if (route && STATIC_ROUTES.has(route)) {
		return (
			<SettingsPage
				projects={view.projects}
				section={
					route === "settings/mcp"
						? "mcp"
						: route.replace("settings/", "").replace("settings", "tidy")
				}
			/>
		);
	}
	if (route?.startsWith("docker/")) {
		const name = route.slice("docker/".length);
		const project = view.docker.projects.find((entry) => entry.name === name);
		return project ? (
			<div className="overview">
				<div className="cards cards--single">
					<ComposeCard dockerUp={view.docker.available} project={project} />
				</div>
			</div>
		) : (
			<p className="muted pad">Такого проекта Docker больше нет.</p>
		);
	}
	const selectedProject = view.projects.find(
		(entry) => projectRoute(entry.id) === route
	);
	const boardProject = view.projects.find(
		(entry) =>
			route === `projects/${encodeURIComponent(entry.id)}/canvas` ||
			route === `projects/${encodeURIComponent(entry.id)}/kanban`
	);
	if (boardProject) {
		return (
			<KnowledgePage
				key={boardProject.id}
				project={boardProject}
				section={route?.endsWith("/canvas") ? "canvas" : "kanban"}
			/>
		);
	}
	if (selectedProject) {
		return (
			<ProjectPage
				key={selectedProject.id}
				onDeleted={onDeleted}
				project={selectedProject}
			/>
		);
	}
	const service = view.projects
		.flatMap((project) => project.services)
		.find((entry) => entry.key === route);
	if (route && service) {
		// Keyed, so another service opens afresh on its first page.
		return (
			<ServicePage
				key={service.key}
				projectName={
					view.projects.find((entry) => entry.id === service.project)?.name
				}
				service={service}
			/>
		);
	}
	return <StartPage onDeleted={onDeleted} view={view} />;
}

export function App() {
	const { connected, reloadAvailable, view } = useHub();
	const [route, go] = useRoute();
	const deleted = useCallback(() => go(null), [go]);
	useEffect(() => {
		if (
			!(view && route) ||
			STATIC_ROUTES.has(route) ||
			route.startsWith("docker/")
		) {
			return;
		}
		const exists = view.projects.some(
			(project) =>
				projectRoute(project.id) === route ||
				route === `projects/${encodeURIComponent(project.id)}/canvas` ||
				route === `projects/${encodeURIComponent(project.id)}/kanban` ||
				project.services.some((service) => service.key === route)
		);
		if (!exists) {
			go(null);
		}
	}, [go, route, view]);
	return (
		<ProjectPreferencesProvider>
			<QueueProvider>
				<div className={route === null ? "app app--start" : "app"}>
					<header className="header">
						<a className="brand" href="#/">
							<span aria-hidden="true" className="brand__mark" />
							<strong>DevHub</strong>
						</a>
						{view ? (
							<RunningProjectsMenu projects={view.projects} />
						) : (
							<span className="header__services muted">
								читаю, что запущено…
							</span>
						)}
						<nav aria-label="Быстрые ссылки" className="header__links">
							<a href="#/settings">Настройки</a>
						</nav>
						<HeaderStatus connected={connected} />
					</header>
					{route === null ? null : (
						<Sidebar onOpen={go} selected={route} view={view} />
					)}
					<main className="main">
						{view ? (
							<Main onDeleted={deleted} route={route} view={view} />
						) : (
							<p className="muted pad">Загрузка…</p>
						)}
					</main>
					{reloadAvailable ? <ReloadNotice /> : null}
				</div>
			</QueueProvider>
		</ProjectPreferencesProvider>
	);
}
