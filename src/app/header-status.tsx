import type { QueueState, QueueView } from "../queue";
import { useQueue } from "./queue";
import { cx } from "./words";

const STATE_WORDS: Record<QueueState, string> = {
	offline: "Нет связи",
	paused: "На паузе",
	ready: "Готова",
	stopped: "Остановлена",
	working: "В работе",
};

/** Counts only: the header stays compact and never names a private job. */
export function InferenceStatus({
	available,
	queue,
}: {
	available: boolean;
	queue: QueueView;
}) {
	const state = available ? queue.state : "offline";
	const online = state !== "offline";
	const counts = online
		? `${queue.running} выполняется · ${queue.queued ?? "?"} в очереди`
		: "Нет данных об очереди";
	return (
		<a
			className={cx("queue-status", `queue-status--${state}`)}
			href={queue.panel}
			title={`Открыть панель Inference · ${STATE_WORDS[state]} · ${counts}`}
		>
			<span aria-hidden="true" className="queue-status__dot" />
			<span className="queue-status__body">
				<span className="queue-status__head">
					<strong>Inference</strong>
					<span className="queue-status__state">{STATE_WORDS[state]}</span>
				</span>
				<span className="queue-status__counts">{counts}</span>
			</span>
		</a>
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
			>
				<span className="live__label">{connection}</span>
			</span>
		</div>
	);
}
