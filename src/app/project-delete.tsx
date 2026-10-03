import {
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { ProjectView } from "../hub";
import type { DeletionPlan } from "../projects";
import { deleteProject, projectDeletionPlan } from "./api";

const PATH_LABELS = {
	alias: "Старая копия",
	project: "Основная папка",
	worktree: "Worktree",
};

/** The complete file impact, also visible when a blocker prevents deletion. */
export function DeletionDetails({ plan }: { plan: DeletionPlan }) {
	return (
		<>
			<ul className="delete-paths">
				{plan.paths.map((entry) => (
					<li key={entry.path}>
						<span className="muted small">{PATH_LABELS[entry.kind]}</span>
						<code>{entry.path}</code>
					</li>
				))}
			</ul>
			{plan.warnings.length > 0 ? (
				<div className="warn">
					<ul className="delete-notes">
						{plan.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</div>
			) : null}
			{plan.blockers.length > 0 ? (
				<div className="error" role="alert">
					<strong>Пока нельзя удалить</strong>
					<ul className="delete-notes">
						{plan.blockers.map((blocker) => (
							<li key={blocker}>{blocker}</li>
						))}
					</ul>
				</div>
			) : null}
		</>
	);
}

export function DeleteProjectDialog({
	onClose,
	onDeleted,
	project,
}: {
	onClose: () => void;
	onDeleted: (id: string) => void;
	project: ProjectView;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [plan, setPlan] = useState<DeletionPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		setPlan(null);
		try {
			setPlan(await projectDeletionPlan(project.id));
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setLoading(false);
		}
	}, [project.id]);
	useEffect(() => {
		dialog.current?.showModal();
		load();
	}, [load]);
	const remove = useCallback(async () => {
		if (!plan || plan.blockers.length > 0 || pending) {
			return;
		}
		setPending(true);
		setError(null);
		try {
			await deleteProject(project.id, plan.token);
			onDeleted(project.id);
			onClose();
		} catch (cause) {
			setError((cause as Error).message);
			// A used or expired plan must be reviewed again before another attempt.
			setPlan(null);
		} finally {
			setPending(false);
		}
	}, [onClose, onDeleted, pending, plan, project.id]);
	const cancel = useCallback(
		(event: SyntheticEvent<HTMLDialogElement>) => {
			if (pending) {
				event.preventDefault();
			} else {
				onClose();
			}
		},
		[onClose, pending]
	);
	return (
		<dialog
			aria-labelledby="delete-project-title"
			className="confirm confirm--delete"
			onCancel={cancel}
			ref={dialog}
		>
			<h2 id="delete-project-title">Удалить {project.name}?</h2>
			<p>
				Dev-сервисы проекта остановятся. Папки ниже удалятся с диска вместе со
				всеми файлами без корзины, а проект исчезнет из пульта.
			</p>
			{plan ? (
				<DeletionDetails plan={plan} />
			) : (
				<p className="delete-folder">
					<code>{project.path}</code>
				</p>
			)}
			{loading ? <p role="status">Проверяю папки и зависимости…</p> : null}
			{error ? (
				<p className="error" role="alert">
					{error}
				</p>
			) : null}
			{pending ? <p role="status">Останавливаю dev и удаляю файлы…</p> : null}
			<div className="confirm__actions">
				{error || (plan && plan.blockers.length > 0) ? (
					<button
						className="button"
						disabled={loading || pending}
						onClick={load}
						type="button"
					>
						Обновить список
					</button>
				) : null}
				<button
					className="button"
					disabled={pending}
					onClick={onClose}
					type="button"
				>
					Отмена
				</button>
				<button
					className="button button--danger"
					disabled={!plan || plan.blockers.length > 0 || loading || pending}
					onClick={remove}
					type="button"
				>
					{pending ? "Удаляю…" : "Удалить проект"}
				</button>
			</div>
		</dialog>
	);
}

export function DeleteProjectButton({
	onDeleted,
	project,
}: {
	onDeleted: (id: string) => void;
	project: ProjectView;
}) {
	const [opened, setOpened] = useState(false);
	const open = useCallback(() => setOpened(true), []);
	const close = useCallback(() => setOpened(false), []);
	return (
		<>
			<button
				className="button button--delete"
				disabled={!project.deletable}
				onClick={open}
				title={
					project.deletable
						? "Удалить проект и его папки с компьютера"
						: "Пульт нельзя удалить из самого пульта"
				}
				type="button"
			>
				Удалить проект…
			</button>
			{opened ? (
				<DeleteProjectDialog
					onClose={close}
					onDeleted={onDeleted}
					project={project}
				/>
			) : null}
		</>
	);
}
