import {
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { QueueJob, QueueJobDetails } from "../queue";
import { readHub } from "./api";
import { DialogPortal } from "./dialog-portal";

const STATES: Record<string, string> = {
	cancelled: "Отменено",
	failed: "Ошибка",
	interrupted: "Прервано",
	needs_attention: "Требует внимания",
	queued: "В очереди",
	running: "Выполняется",
	succeeded: "Завершено",
};

export const readJobDetails = async (id: string): Promise<QueueJobDetails> =>
	(
		await readHub<{ job: QueueJobDetails }>(
			`/api/queue/jobs/${encodeURIComponent(id)}`
		)
	).job;

const seconds = (value: number | null): string | null => {
	if (value === null) {
		return null;
	}
	const rounded = Math.round(value);
	return rounded < 60
		? `${rounded} с`
		: `${Math.floor(rounded / 60)} мин ${rounded % 60} с`;
};

const date = (value: number | null): string | null =>
	value === null ? null : new Date(value).toLocaleString("ru-RU");

const memory = (value: number | null): string | null =>
	value === null
		? null
		: `${(value / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;

export function JobFacts({ detail }: { detail: QueueJobDetails }) {
	const facts: [string, string | number | null][] = [
		["Состояние", STATES[detail.state] ?? "Неизвестно"],
		["ID", detail.id],
		["Профиль", detail.profile],
		["Ресурс", detail.resource?.toUpperCase() ?? null],
		["Приоритет", detail.priority],
		["Позиция в очереди", detail.position],
		["Создано", date(detail.createdAt)],
		["Начато", date(detail.startedAt)],
		["Завершено", date(detail.finishedAt)],
		["Ожидание", seconds(detail.queuedSeconds)],
		["Время работы", seconds(detail.runningSeconds)],
		["Оценка длительности", seconds(detail.expectedSeconds)],
		["Видеопамять", memory(detail.vramMb)],
		["Оперативная память", memory(detail.ramMb)],
		["Потоки CPU", detail.cpuThreads],
		["Бюджет GPU", detail.gpuCompute === null ? null : `${detail.gpuCompute}%`],
		["Пик видеопамяти", memory(detail.peakVramMb)],
		["Пик оперативной памяти", memory(detail.peakRamMb)],
		["PID", detail.pid],
		[
			"Размер журнала",
			detail.outputBytes === null
				? null
				: `${detail.outputBytes.toLocaleString("ru-RU")} байт`,
		],
		["Без нового вывода", seconds(detail.quietSeconds)],
	];
	return (
		<>
			{detail.waitingFor ? <p className="note">{detail.waitingFor}</p> : null}
			<dl className="queue-detail__facts">
				{facts
					.filter(([, value]) => value !== null)
					.map(([label, value]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
			</dl>
		</>
	);
}

export function JobDetailDialog({
	job,
	onClose,
}: {
	job: QueueJob;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const asked = useRef(0);
	const [detail, setDetail] = useState<QueueJobDetails | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const close = useCallback(
		(event: SyntheticEvent) => {
			event.preventDefault();
			dialog.current?.close();
			onClose();
		},
		[onClose]
	);
	const refresh = useCallback(() => {
		if (job.private) {
			return;
		}
		asked.current += 1;
		const question = asked.current;
		setPending(true);
		setError(null);
		readJobDetails(job.id)
			.then((answer) => {
				if (question === asked.current) {
					setDetail(answer);
				}
			})
			.catch((problem: Error) => {
				if (question === asked.current) {
					setError(problem.message);
					setDetail(null);
				}
			})
			.finally(() => {
				if (question === asked.current) {
					setPending(false);
				}
			});
	}, [job.id, job.private]);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		refresh();
		return () => {
			asked.current += 1;
			element?.close();
		};
	}, [refresh]);
	return (
		<DialogPortal>
			<dialog
				aria-label="Подробности задания"
				className="queue-detail"
				onCancel={close}
				ref={dialog}
			>
				<header className="queue-detail__head">
					<div>
						<p className="muted small">Подробности задания</p>
						<h2>{job.private ? "Анонимное задание" : job.name}</h2>
					</div>
					<button
						aria-label="Закрыть подробности задания"
						className="button button--small"
						onClick={close}
						type="button"
					>
						Закрыть
					</button>
				</header>
				{job.private ? (
					<p className="muted">Подробности приватного задания скрыты.</p>
				) : (
					<>
						{error ? (
							<p className="error" role="alert">
								{error}
							</p>
						) : null}
						{detail ? <JobFacts detail={detail} /> : null}
						{pending && !detail ? (
							<p className="muted">Загружаю подробности…</p>
						) : null}
						<div className="queue-detail__actions">
							<button
								className="button button--small"
								disabled={pending}
								onClick={refresh}
								type="button"
							>
								{pending ? "Обновляю…" : "Обновить"}
							</button>
						</div>
					</>
				)}
			</dialog>
		</DialogPortal>
	);
}
