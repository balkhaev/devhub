import type { MouseEvent } from "react";

import type { ComposeView } from "../docker";
import type { HubView, ProjectView } from "../hub";
import { useAction } from "./actions";
import { FrontendLink, ProjectControls } from "./project-controls";
import { DeleteProjectButton } from "./project-delete";
import { projectRoute } from "./project-ui";
import {
	composeStatus,
	composeWords,
	containerStatus,
	cx,
	isUp,
	STATUS_SHORT,
	servicesWord,
} from "./words";

/** Everything at once: what runs now, every project with its services, Docker and every listening port. */

/** Bring up and stop buttons of a compose project; none while Docker itself is not running. */
function ComposeButtons({
	dockerUp,
	pending,
	project,
	run,
}: {
	dockerUp: boolean;
	pending: string | null;
	project: ComposeView;
	run: (event: MouseEvent<HTMLButtonElement>) => Promise<void>;
}) {
	if (!dockerUp) {
		return null;
	}
	const up = `/api/docker/${project.name}/up`;
	const running = project.containers.some((container) => container.running);
	// Something to start: a container that is missing or stopped (running but unhealthy is not helped by it).
	const missing =
		project.containers.length === 0 ||
		project.containers.some(
			(container) =>
				!container.running &&
				container.exitCode !== 0 &&
				(project.wanted.length === 0 ||
					project.wanted.includes(container.service))
		) ||
		project.wanted.some(
			(service) =>
				!project.containers.some((container) => container.service === service)
		);
	const startable =
		missing && (project.file !== null || project.containers.length > 0);
	return (
		<>
			{project.ready || !startable ? null : (
				<button
					className="button button--small"
					data-path={up}
					disabled={pending !== null}
					onClick={run}
					title={
						project.wanted.length > 0
							? `docker compose up -d ${project.wanted.join(" ")}`
							: "docker compose up -d"
					}
					type="button"
				>
					{pending === up ? "Поднимаю…" : "Поднять"}
				</button>
			)}
			{running ? (
				<button
					className="button button--small"
					data-confirm={`Остановить контейнеры ${project.name}?`}
					data-path={`/api/docker/${project.name}/stop`}
					disabled={pending !== null}
					onClick={run}
					type="button"
				>
					Остановить
				</button>
			) : null}
		</>
	);
}

function ProjectCard({
	dockerUp,
	onDeleted,
	project,
}: {
	dockerUp: boolean;
	onDeleted: (id: string) => void;
	project: ProjectView;
}) {
	const { dialog, error, pending, run } = useAction();
	const { docker } = project;
	return (
		<article className="card">
			<header className="card__head">
				<div>
					<h2>
						<a href={`#/${projectRoute(project.id)}`}>{project.name}</a>
					</h2>
					{project.description ? (
						<p className="muted small">{project.description}</p>
					) : null}
				</div>
				<div className="card__actions">
					<FrontendLink project={project} />
				</div>
			</header>
			<p className="card__folder muted small">
				<span>dev · {project.currentBranch ?? "без Git-ветки"}</span>
				<code>{project.path}</code>
			</p>
			<ProjectControls project={project} />
			<ul className="card__services">
				{project.services.map((service) => (
					<li key={service.key}>
						<a className="card__service" href={`#/${service.key}`}>
							<span className={cx("dot", `dot--${service.status}`)} />
							<span>{service.name}</span>
							<span className="muted small">
								{service.port ? `:${service.port}` : ""}{" "}
								{STATUS_SHORT[service.status]}
							</span>
						</a>
					</li>
				))}
				{docker ? (
					<li className="card__service card__docker">
						<span className={cx("dot", `dot--${composeStatus(docker)}`)} />
						<a className="card__docker-link" href={`#/docker/${docker.name}`}>
							Docker {docker.name}
							{docker.wanted.length > 0 ? ` (${docker.wanted.join(", ")})` : ""}
						</a>
						<span className="muted small">
							{composeWords(docker, dockerUp)}
						</span>
						<ComposeButtons
							dockerUp={dockerUp}
							pending={pending}
							project={docker}
							run={run}
						/>
					</li>
				) : null}
			</ul>
			{error ? <p className="error small">{error}</p> : null}
			<footer className="card__footer">
				<a className="muted small" href={`#/${projectRoute(project.id)}`}>
					Управление проектом
				</a>
				<DeleteProjectButton onDeleted={onDeleted} project={project} />
			</footer>
			{dialog}
		</article>
	);
}

export function ComposeCard({
	dockerUp = true,
	project,
}: {
	dockerUp?: boolean;
	project: ComposeView;
}) {
	const { dialog, error, pending, run } = useAction();
	return (
		<article className="card">
			<header className="card__head">
				<div>
					<h2>
						<span className={cx("dot", `dot--${composeStatus(project)}`)} />{" "}
						{project.name}
					</h2>
					<p className="muted small">
						{composeWords(project, dockerUp)}
						{project.project
							? ` · нужен проекту ${project.project}${
									project.wanted.length > 0
										? `: ${project.wanted.join(", ")}`
										: ""
								}`
							: ""}
					</p>
					<p className="muted small">
						{project.file ?? "файла compose больше нет: только сами контейнеры"}
					</p>
				</div>
				<div className="card__actions">
					<ComposeButtons
						dockerUp={dockerUp}
						pending={pending}
						project={project}
						run={run}
					/>
				</div>
			</header>
			<ul className="card__services">
				{project.containers.map((container) => (
					<li className="card__service" key={container.name}>
						<span className={cx("dot", `dot--${containerStatus(container)}`)} />
						<span>{container.service || container.name}</span>
						<span className="muted small">
							{container.running && container.ports
								? container.ports
								: container.status}
						</span>
					</li>
				))}
			</ul>
			{error ? <p className="error small">{error}</p> : null}
			{dialog}
		</article>
	);
}

function Ports({ view }: { view: HubView }) {
	return (
		<table className="table">
			<thead>
				<tr>
					<th>Порт</th>
					<th>Сервис</th>
					<th>Кто держит</th>
				</tr>
			</thead>
			<tbody>
				{view.ports.map((entry) => (
					<tr key={entry.port}>
						<td>
							<a
								href={`http://127.0.0.1:${entry.port}/`}
								rel="noopener"
								target="_blank"
							>
								{entry.port}
							</a>
						</td>
						<td>
							{entry.service ? (
								<a href={`#/${entry.service}`}>{entry.service}</a>
							) : (
								"—"
							)}
						</td>
						<td className="muted" title={entry.owner?.command}>
							{entry.owner?.label ?? "—"}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** Compose projects no catalogue project uses, or a word that Docker does not answer. */
function DockerSection({
	available,
	others,
}: {
	available: boolean;
	others: ComposeView[];
}) {
	if (!available) {
		return (
			<p className="warn">
				Docker не отвечает: контейнеры не видны. Запустите Docker Desktop.
			</p>
		);
	}
	if (others.length === 0) {
		return null;
	}
	return (
		<section>
			<h2 className="section-title">Другие проекты Docker</h2>
			<div className="cards">
				{others.map((project) => (
					<ComposeCard key={project.name} project={project} />
				))}
			</div>
		</section>
	);
}

export function Overview({
	onDeleted,
	view,
}: {
	onDeleted: (id: string) => void;
	view: HubView;
}) {
	const services = view.projects.flatMap((project) => project.services);
	const up = services.filter((service) => isUp(service.status));
	const managed = services.filter((service) => service.managed);
	const used = new Set(
		view.projects.flatMap((project) =>
			project.docker ? [project.docker.name] : []
		)
	);
	// Compose projects no catalogue project uses: the ones that are, show on their projects' cards.
	const others = view.docker.projects.filter(
		(project) => !used.has(project.name)
	);
	return (
		<div className="overview">
			<section className="overview__now">
				<h1>Сейчас</h1>
				<p className="muted">
					Работают {servicesWord(up.length)} из {services.length}; из пульта
					запущено {managed.length}.
				</p>
				<div className="chips">
					{up.map((service) => (
						<a className="chip" href={`#/${service.key}`} key={service.key}>
							<span className={cx("dot", `dot--${service.status}`)} />
							{service.name}
							{service.port ? (
								<span className="muted">:{service.port}</span>
							) : null}
						</a>
					))}
				</div>
			</section>
			<section>
				<h2 className="section-title">Проекты</h2>
				<div className="cards">
					{view.projects.map((project) => (
						<ProjectCard
							dockerUp={view.docker.available}
							key={project.id}
							onDeleted={onDeleted}
							project={project}
						/>
					))}
				</div>
			</section>
			<DockerSection available={view.docker.available} others={others} />
			<section>
				<h2 className="section-title">Кто слушает порты</h2>
				<Ports view={view} />
			</section>
		</div>
	);
}
