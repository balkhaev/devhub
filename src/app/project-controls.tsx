import type { ProjectView } from "../hub";
import { useAction } from "./actions";
import { mainFrontend } from "./project-ui";
import { isUp } from "./words";

export function FrontendLink({ project }: { project: ProjectView }) {
	const frontend = mainFrontend(project);
	return frontend ? (
		<a
			className="button button--primary"
			href={frontend.url}
			rel="noopener"
			target="_blank"
			title={`${frontend.label} · ${frontend.url}`}
		>
			Открыть приложение ↗
		</a>
	) : null;
}

export function ProjectControls({ project }: { project: ProjectView }) {
	const { dialog, error, pending, run } = useAction();
	const defaults = new Set(project.devServices);
	const down = project.services.filter(
		(service) =>
			defaults.has(service.key) &&
			service.canStart &&
			!isUp(service.status) &&
			service.status !== "busy"
	);
	const warnings = down.flatMap((service) =>
		service.warn ? [`${service.name}: ${service.warn}`] : []
	);
	const managed = project.services.some((service) => service.managed);
	const start = `/api/projects/${encodeURIComponent(project.id)}/start`;
	const stop = `/api/projects/${encodeURIComponent(project.id)}/stop`;
	return (
		<div className="project-controls">
			<div className="service__actions">
				{down.length > 0 ? (
					<button
						className="button"
						data-confirm={
							warnings.length > 0
								? `${warnings.join("\n\n")}\n\nЗапустить dev?`
								: undefined
						}
						data-path={start}
						disabled={pending !== null}
						onClick={run}
						title={down.map((service) => service.name).join(", ")}
						type="button"
					>
						{pending === start ? "Запускаю dev…" : "Запустить dev"}
					</button>
				) : null}
				{managed ? (
					<button
						className="button"
						data-path={stop}
						disabled={pending !== null}
						onClick={run}
						title="Остановить dev-сервисы, запущенные из пульта"
						type="button"
					>
						{pending === stop ? "Останавливаю…" : "Остановить dev"}
					</button>
				) : null}
			</div>
			{error ? <p className="error small">{error}</p> : null}
			{dialog}
		</div>
	);
}
