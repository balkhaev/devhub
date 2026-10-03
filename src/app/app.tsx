import { useHub, useRoute } from "./api";
import { ComposeCard, Overview } from "./overview";
import { ServicePage } from "./service";
import { Sidebar } from "./sidebar";
import { cx, isUp } from "./words";

/**
 * The hub: every local project's dev servers on the left, the chosen one's pages, log and details on the right, and
 * an overview of what runs, Docker and every listening port. It follows the computer live.
 */

function Main({
	route,
	view,
}: {
	route: string | null;
	view: NonNullable<ReturnType<typeof useHub>["view"]>;
}) {
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
	const service = view.projects
		.flatMap((project) => project.services)
		.find((entry) => entry.key === route);
	if (route && service) {
		// Keyed, so another service opens afresh on its first page.
		return <ServicePage key={service.key} service={service} />;
	}
	return <Overview view={view} />;
}

export function App() {
	const { connected, view } = useHub();
	const [route, go] = useRoute();
	const services = view?.projects.flatMap((project) => project.services) ?? [];
	const up = services.filter((service) => isUp(service.status)).length;
	return (
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
					<Main route={route} view={view} />
				) : (
					<p className="muted pad">Загрузка…</p>
				)}
			</main>
		</div>
	);
}
