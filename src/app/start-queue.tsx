import type { QueueJob, QueueView } from "../queue";
import { JobProgress } from "./job-progress";
import { QUEUE_STALE_MS, useQueue } from "./queue";
import { since } from "./words";

const PREVIEW_LIMIT = 5;

function JobGroup({
	count,
	jobs,
	running,
}: {
	count: number | null;
	jobs: QueueJob[] | null;
	running: boolean;
}) {
	if (count === 0 && !jobs?.length) {
		return null;
	}
	const shown = jobs?.slice(0, PREVIEW_LIMIT) ?? [];
	const remaining = Math.max(count ?? 0, jobs?.length ?? 0) - shown.length;
	return (
		<div className="start-queue__group">
			<h3>
				{running ? "Выполняется" : "В очереди"} <span>{count ?? "?"}</span>
			</h3>
			{shown.length > 0 ? (
				<ol className="start-queue__jobs">
					{shown.map((job, index) => (
						<li className={running ? "start-queue__running" : ""} key={job.id}>
							<span aria-hidden="true" className="start-queue__position">
								{running ? "●" : index + 1}
							</span>
							<div className="start-queue__job">
								<strong>{job.private ? "Анонимное задание" : job.name}</strong>
								<span className="start-queue__meta">
									{[
										job.resource?.toUpperCase(),
										job.private ? job.id.slice(0, 8) : null,
										running && job.startedAt !== null
											? since(job.startedAt)
											: null,
									]
										.filter(Boolean)
										.join(" · ")}
								</span>
								{running ? <JobProgress progress={job.progress} /> : null}
							</div>
						</li>
					))}
				</ol>
			) : (
				<p className="start-queue__meta">Список заданий недоступен</p>
			)}
			{remaining > 0 ? (
				<p className="start-queue__meta">Ещё заданий в панели: {remaining}</p>
			) : null}
		</div>
	);
}

/** A read-only preview of current work; the existing provider owns all polling. */
export function InferenceQueue({
	available,
	now = Date.now(),
	queue,
	receivedAt,
}: {
	available: boolean;
	now?: number;
	queue: QueueView | null;
	receivedAt: number | null;
}) {
	if (
		!(available && queue) ||
		queue.state === "offline" ||
		receivedAt === null ||
		now - receivedAt > QUEUE_STALE_MS ||
		!(
			queue.running ||
			queue.queued ||
			queue.jobs.length ||
			queue.queuedJobs?.length
		)
	) {
		return null;
	}
	const held = queue.state === "paused" || queue.state === "stopped";
	const reason = queue.jobs.length === 0 ? queue.waitingFor[0] : null;
	return (
		<section aria-labelledby="start-queue-title" className="start-queue">
			<div className="start-queue__head">
				<div>
					<h2 id="start-queue-title">Очередь Inference</h2>
					<p>
						{queue.running} выполняется · {queue.queued ?? "?"} в очереди
					</p>
				</div>
				<a className="start-queue__link" href={queue.panel}>
					Панель очереди <span aria-hidden="true">→</span>
				</a>
			</div>
			{held ? (
				<p className="start-queue__notice">
					{queue.state === "stopped"
						? "Очередь остановлена"
						: "Очередь на паузе"}
					. Новые задания ждут, начатые продолжаются.
				</p>
			) : null}
			{reason ? <p className="start-queue__notice">{reason}</p> : null}
			<div className="start-queue__groups">
				<JobGroup count={queue.running} jobs={queue.jobs} running />
				<JobGroup
					count={queue.queued}
					jobs={queue.queuedJobs}
					running={false}
				/>
			</div>
		</section>
	);
}

export function StartQueue() {
	const { available, queue, receivedAt } = useQueue();
	return (
		<InferenceQueue
			available={available}
			queue={queue}
			receivedAt={receivedAt}
		/>
	);
}
