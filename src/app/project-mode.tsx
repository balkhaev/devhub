import { type ChangeEvent, useCallback, useState } from "react";

import type { ProjectView } from "../hub";
import { setProjectMode } from "./api";

export function ProjectModeBadge({ project }: { project: ProjectView }) {
	const names = { mvp: "MVP", prod: "Прод" };
	return (
		<span className={`project-mode project-mode--${project.mode ?? "unset"}`}>
			{project.mode ? names[project.mode] : "Режим не настроен"}
		</span>
	);
}

function ProjectModeDescription({ project }: { project: ProjectView }) {
	if (project.mode === "mvp") {
		return (
			<p className="muted small">
				{project.localOnly ? (
					<>
						После проверок изменения сохраняются в локальном{" "}
						<strong>{project.releaseBranch}</strong>.
					</>
				) : (
					<>
						После проверок изменения сразу идут в{" "}
						<strong>{project.releaseBranch}</strong> и прод.
					</>
				)}{" "}
				Завершённый worktree удаляется после задачи.
			</p>
		);
	}
	if (project.mode === "prod") {
		return (
			<p className="muted small">
				Изменения собираются в <strong>{project.integrationBranch}</strong>.
				Выпуск в <strong>{project.releaseBranch}</strong> и прод — после
				финальной проверки и отдельного разрешения.
			</p>
		);
	}
	return (
		<p className="muted small">Сначала настройте workflow проекта в DevHub.</p>
	);
}

export function ProjectModeControl({ project }: { project: ProjectView }) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const change = useCallback(
		async (event: ChangeEvent<HTMLSelectElement>) => {
			const mode = event.currentTarget.value;
			if (
				pending ||
				(mode !== "mvp" && mode !== "prod") ||
				mode === project.mode
			) {
				return;
			}
			setPending(true);
			setError(null);
			try {
				await setProjectMode(project.id, mode);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setPending(false);
			}
		},
		[pending, project.id, project.mode]
	);
	return (
		<div className="project-workflow">
			<label className="project-workflow__choice">
				<span>Режим проекта</span>
				<select
					disabled={pending || !project.modeEditable}
					onChange={change}
					value={project.mode ?? ""}
				>
					{project.mode ? null : <option value="">Не настроен</option>}
					<option value="mvp">MVP</option>
					<option value="prod">Прод</option>
				</select>
				{pending ? <span role="status">Сохраняю…</span> : null}
			</label>
			<ProjectModeDescription project={project} />
			{error ? (
				<p className="error small" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
