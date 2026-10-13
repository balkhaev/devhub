import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { QueueState, QueueView } from "../queue";
import { useQueue } from "./queue";
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
	queue,
}: {
	available: boolean;
	queue: QueueView;
}) {
	if (!available || queue.state === "offline") {
		return <p className="muted">Нет данных об очереди</p>;
	}
	const groups = [
		{ count: queue.running, jobs: queue.jobs, title: "Выполняется" },
		{ count: queue.queued, jobs: queue.queuedJobs, title: "В очереди" },
	];
	return (
		<>
			{queue.state === "paused" || queue.state === "stopped" ? (
				<p className="warn small">
					{STATE_WORDS[queue.state]}. Новые задания ждут, начатые продолжаются.
				</p>
			) : null}
			{groups.map(({ count, jobs, title }) => (
				<section className="queue-popover__group" key={title}>
					<h3>
						{title} <span className="muted">{count ?? "?"}</span>
					</h3>
					{jobs && jobs.length > 0 ? (
						<ol className="queue-popover__jobs">
							{jobs.map((job) => (
								<li key={job.id}>
									<span className="queue-popover__name">
										{job.private ? "Анонимное задание" : job.name}
									</span>
									<span className="muted small">
										{[
											job.resource?.toUpperCase(),
											job.startedAt === null ? null : since(job.startedAt),
										]
											.filter(Boolean)
											.join(" · ")}
									</span>
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
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const listId = useId();
	const toggle = useCallback(() => setOpen((current) => !current), []);
	useEffect(() => {
		if (!open) {
			return;
		}
		const outside = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				!root.current?.contains(event.target)
			) {
				setOpen(false);
			}
		};
		const escapeKey = (event: KeyboardEvent) => {
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
					<h2>Очередь Inference</h2>
					<QueueList available={available} queue={queue} />
				</section>
			) : null}
		</div>
	);
}

export function HeaderStatus({ connected }: { connected: boolean }) {
	const { available, queue } = useQueue();
	const connection = connected ? "на связи" : "нет связи с пультом";
	return (
		<div className="header-status">
			{queue ? (
				<InferenceStatus available={connected && available} queue={queue} />
			) : null}
			<span
				aria-label={connection}
				className={cx("live", connected && "live--on")}
				role="status"
				title={connection}
			/>
		</div>
	);
}
