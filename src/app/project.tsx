import type { ProjectView } from "../hub";
import { FrontendLink, ProjectControls } from "./project-controls";
import { DeleteProjectButton } from "./project-delete";
import { FavoriteProjectButton } from "./project-preference-controls";
import { mainFrontend } from "./project-ui";
import { cx, STATUS_WORDS } from "./words";

export function ProjectPage({
	onDeleted,
	project,
}: {
	onDeleted: (id: string) => void;
	project: ProjectView;
}) {
	const frontend = mainFrontend(project);
	const branch = project.currentBranch ?? "нет Git-ветки";
	const unexpected = Boolean(
		project.stageBranch && project.currentBranch !== project.stageBranch
	);
	return (
		<section aria-label={project.name} className="project-page">
			<header className="project-page__head">
				<div>
					<h1>{project.name}</h1>
					{project.description ? (
						<p className="muted">{project.description}</p>
					) : null}
				</div>
				<div className="card__actions">
					<FavoriteProjectButton project={project} />
					<FrontendLink project={project} />
				</div>
			</header>
			<div className="card project-stage">
				<h2>Dev / stage</h2>
				<code>{project.path}</code>
				<p className="muted small">
					Ветка: <strong>{branch}</strong>
					{project.stageBranch ? ` · stage: ${project.stageBranch}` : ""}
				</p>
				{unexpected ? (
					<p className="warn">
						Для dev основная папка должна быть на ветке {project.stageBranch}.
					</p>
				) : null}
				<ProjectControls project={project} />
			</div>
			<section>
				<h2 className="section-title">Основной интерфейс</h2>
				{frontend ? (
					<div className="project-frontend">
						<strong>{frontend.label}</strong>
						<a href={frontend.url} rel="noopener" target="_blank">
							<code>{frontend.url}</code> ↗
						</a>
						<span className="muted small">
							{frontend.service.name} · {STATUS_WORDS[frontend.service.status]}
						</span>
					</div>
				) : (
					<p className="muted">У проекта нет отдельного веб-интерфейса.</p>
				)}
			</section>
			<section>
				<h2 className="section-title">Dev-сервисы</h2>
				<ul className="project-services">
					{project.services.map((service) => (
						<li key={service.key}>
							<a className="project-services__link" href={`#/${service.key}`}>
								<span className={cx("dot", `dot--${service.status}`)} />
								<strong>{service.name}</strong>
								<span className="muted small">
									{service.port ? `:${service.port} · ` : ""}
									{STATUS_WORDS[service.status]}
								</span>
								<span className="muted small">Лог и управление →</span>
							</a>
						</li>
					))}
				</ul>
				{project.services.length === 0 ? (
					<p className="muted">Dev-сервисы ещё не настроены.</p>
				) : null}
			</section>
			<footer className="project-page__footer">
				<DeleteProjectButton onDeleted={onDeleted} project={project} />
			</footer>
		</section>
	);
}
