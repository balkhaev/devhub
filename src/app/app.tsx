import { useCallback, useEffect } from "react";

import { AiPage } from "./ai";
import { useHub, useRoute } from "./api";
import { CreatePage } from "./create";
import { ComposeCard, Overview } from "./overview";
import { ProdPage } from "./prod";
import { ProjectPage } from "./project";
import { ProjectPreferencesProvider } from "./project-preferences";
import { projectRoute } from "./project-ui";
import { ServicePage } from "./service";
import { Sidebar } from "./sidebar";
import { cx, isUp } from "./words";

/**
 * The hub: every local project's dev servers on the left, the chosen one's pages, log and details on the right, and
 * an overview of what runs, Docker and every listening port. It follows the computer live.
 */

const STATIC_ROUTES = new Set(["ai", "new", "prod"]);

function Main({
	onDeleted,
	route,
	view,
}: {
	onDeleted: (id: string) => void;
	route: string | null;
	view: NonNullable<ReturnType<typeof useHub>["view"]>;
}) {
	if (route === "ai") {
		return <AiPage />;
	}
	if (route === "new") {
		return <CreatePage />;
	}
	if (route === "prod") {
		return <ProdPage projects={view.projects} />;
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
	return <Overview onDeleted={onDeleted} view={view} />;
}

export function App() {
	const { connected, view } = useHub();
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
				project.services.some((service) => service.key === route)
		);
		if (!exists) {
			go(null);
		}
	}, [go, route, view]);
	const services = view?.projects.flatMap((project) => project.services) ?? [];
	const up = services.filter((service) => isUp(service.status)).length;
	return (
		<ProjectPreferencesProvider>
			<div className="app">
				<header className="header">
					<a className="brand" href="#/">
						<span aria-hidden="true" className="brand__mark" />
						<strong>Пульт</strong>
					</a>
					<span className="muted">
						{view
							? `работают ${up} из ${services.length}`
							: "читаю, что запущено…"}
					</span>
					<span className={cx("live", connected && "live--on")}>
						{connected ? "на связи" : "нет связи с пультом"}
					</span>
				</header>
				<Sidebar onOpen={go} selected={route} view={view} />
				<main className="main">
					{view ? (
						<Main onDeleted={deleted} route={route} view={view} />
					) : (
						<p className="muted pad">Загрузка…</p>
					)}
				</main>
			</div>
		</ProjectPreferencesProvider>
	);
}
