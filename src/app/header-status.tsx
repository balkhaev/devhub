import {
	type MouseEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

import type { QueueJob, QueueState, QueueView } from "../queue";
import {
	CancelJobButton,
	canCancelJob,
	useJobCancellation,
} from "./job-cancel";
import { JobDetailDialog } from "./job-details";
import { JobProgress } from "./job-progress";
import { QueueMeters, useQueue } from "./queue";
import { cx, since } from "./words";

const STATE_WORDS: Record<QueueState, string> = {
	offline: "Нет связи",
	paused: "На паузе",
	ready: "Готова",
	stopped: "Остановлена",
	working: "В работе",
};

export function QueueList({
	available,
	cancellation,
	onCancel,
	onSelect,
	queue,
}: {
	available: boolean;
	cancellation?: ReturnType<typeof useJobCancellation>;
	onCancel?: (event: MouseEvent<HTMLButtonElement>) => void;
	onSelect?: (event: MouseEvent<HTMLButtonElement>) => void;
	queue: QueueView;
}) {
	if (!available || queue.state === "offline") {
		return <p className="muted">Нет данных об очереди</p>;
	}
	const groups = [
		{
			count: queue.running,
			jobs: queue.jobs,
			state: "running",
			title: "Выполняется",
		},
		{
			count: queue.queued,
			jobs: queue.queuedJobs,
			state: "queued",
			title: "В очереди",
		},
	];
	return (
		<>
			{queue.state === "paused" || queue.state === "stopped" ? (
				<p className="warn small">
					{STATE_WORDS[queue.state]}. Новые задания ждут, начатые продолжаются.
				</p>
			) : null}
			<section className="queue-popover__group">
				<h3>Нагрузка</h3>
				{queue.gpu || queue.host ? (
					<QueueMeters queue={queue} />
				) : (
					<p className="muted small">Нет данных о нагрузке</p>
				)}
			</section>
			{groups.map(({ count, jobs, state, title }) => (
				<section className="queue-popover__group" key={title}>
					<h3>
						{title} <span className="muted">{count ?? "?"}</span>
					</h3>
					{jobs && jobs.length > 0 ? (
						<ol className="queue-popover__jobs">
							{jobs.map((job) => (
								<li key={job.id}>
									<button
										className="queue-popover__job"
										data-job={job.id}
										onClick={onSelect}
										title="Подробности задания"
										type="button"
									>
										<span className="queue-popover__name">
											{job.private ? "Анонимное задание" : job.name}
										</span>
										<span className="muted small">
											{[
												job.resource?.toUpperCase(),
												job.private ? job.id.slice(0, 8) : null,
												job.startedAt === null ? null : since(job.startedAt),
											]
												.filter(Boolean)
												.join(" · ")}
										</span>
										<JobProgress progress={job.progress} />
									</button>
									{cancellation && onCancel ? (
										<CancelJobButton
											job={job}
											onClick={onCancel}
											pending={cancellation.pending}
											requested={cancellation.requested.has(job.id)}
											state={state}
										/>
									) : null}
								</li>
							))}
						</ol>
					) : (
						<p className="muted small">
							{count === 0 ? "Нет заданий" : "Список заданий недоступен"}
						</p>
					)}
					{jobs && count !== null && count > jobs.length && jobs.length > 0 ? (
						<p className="muted small">Ещё заданий: {count - jobs.length}</p>
					) : null}
				</section>
			))}
		</>
	);
}

/** Polling updates the disclosure without closing it or exposing private names. */
export function InferenceStatus({
	available,
	queue,
}: {
	available: boolean;
	queue: QueueView;
}) {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<QueueJob | null>(null);
	const [selectedState, setSelectedState] = useState<"queued" | "running">(
		"queued"
	);
	const cancellation = useJobCancellation();
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const listId = useId();
	const toggle = useCallback(() => setOpen((current) => !current), []);
	const close = useCallback(() => setOpen(false), []);
	const cancelFromList = useCallback(
		async (event: MouseEvent<HTMLButtonElement>) => {
			const { job: id, state } = event.currentTarget.dataset;
			const job = [...queue.jobs, ...(queue.queuedJobs ?? [])].find(
				(entry) => entry.id === id
			);
			if (job && canCancelJob(state)) {
				await cancellation.cancel(job, state);
			}
		},
		[cancellation.cancel, queue.jobs, queue.queuedJobs]
	);
	const selectJob = useCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			const job = [...queue.jobs, ...(queue.queuedJobs ?? [])].find(
				(entry) => entry.id === event.currentTarget.dataset.job
			);
			if (job) {
				setSelected(job);
				setSelectedState(
					queue.jobs.some((entry) => entry.id === job.id) ? "running" : "queued"
				);
				setOpen(false);
			}
		},
		[queue.jobs, queue.queuedJobs]
	);
	const closeJob = useCallback(() => {
		setSelected(null);
		button.current?.focus();
	}, []);
	useEffect(() => {
		if (!open) {
			return;
		}
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest("dialog")) {
				return;
			}
			if (
				event.target instanceof Node &&
				!root.current?.contains(event.target)
			) {
				setOpen(false);
			}
		};
		const escapeKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest("dialog")) {
				return;
			}
			if (event.key === "Escape") {
				setOpen(false);
				button.current?.focus();
			}
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escapeKey);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escapeKey);
		};
	}, [open]);
	const state = available ? queue.state : "offline";
	const online = state !== "offline";
	const counts = online
		? `${queue.running} выполняется · ${queue.queued ?? "?"} в очереди`
		: "Нет данных об очереди";
	return (
		<div className="queue-widget" ref={root}>
			<button
				aria-controls={open ? listId : undefined}
				aria-expanded={open}
				className={cx("queue-status", `queue-status--${state}`)}
				onClick={toggle}
				ref={button}
				title="Показать очередь Inference"
				type="button"
			>
				<span aria-hidden="true" className="queue-status__dot" />
				<span className="queue-status__body">
					<span className="queue-status__head">
						<strong>Inference</strong>
						<span className="queue-status__state">{STATE_WORDS[state]}</span>
					</span>
					<span className="queue-status__counts">{counts}</span>
					{online && queue.running === 1 && queue.jobs.length === 1 ? (
						<JobProgress progress={queue.jobs[0]?.progress} />
					) : null}
				</span>
				<span aria-hidden="true" className="queue-status__chevron">
					{open ? "▴" : "▾"}
				</span>
			</button>
			{open ? (
				<section
					aria-label="Очередь Inference"
					className="queue-popover"
					id={listId}
				>
					<div className="queue-popover__head">
						<h2>Очередь Inference</h2>
						<a
							className="button button--small"
							href={queue.panel}
							onClick={close}
						>
							Панель очереди
						</a>
					</div>
					<QueueList
						available={available}
						cancellation={cancellation}
						onCancel={cancelFromList}
						onSelect={selectJob}
						queue={queue}
					/>
					{cancellation.error ? (
						<p className="error small" role="alert">
							{cancellation.error}
						</p>
					) : null}
					{cancellation.notice ? (
						<p className="muted small" role="status">
							{cancellation.notice}
						</p>
					) : null}
				</section>
			) : null}
			{selected ? (
				<JobDetailDialog
					initialState={selectedState}
					job={selected}
					key={selected.id}
					onClose={closeJob}
				/>
			) : null}
			{cancellation.dialog}
		</div>
	);
}

export function HeaderStatus({ connected }: { connected: boolean }) {
	const { available, queue } = useQueue();
	if (!queue) {
		return null;
	}
	return (
		<div className="header-status">
			<InferenceStatus available={connected && available} queue={queue} />
		</div>
	);
}
