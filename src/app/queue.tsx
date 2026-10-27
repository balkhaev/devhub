import {
	type ChangeEvent,
	createContext,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

import type { HubView, ServiceStatus } from "../hub";
import type { QueueExecutor, QueueJob, QueueState, QueueView } from "../queue";
import { useAction } from "./actions";
import { readHub } from "./api";
import { JobProgress } from "./job-progress";
import { cx, since } from "./words";

/**
 * The shared GPU/CPU queue on the overview: what runs and what waits, how loaded the video card and the computer
 * are, the owner's stop, pause and continue, and the queue's remote executors. The hub reads all of it from the
 * queue's own service; a job shows its name, resource, age and safe measured progress.
 */

const POLL_MS = 3000;
export const QUEUE_STALE_MS = 15_000;
const STOP = "/api/queue/stop";
const PAUSE = "/api/queue/pause";
const CONTINUE = "/api/queue/continue";
const STOP_QUESTION =
	"Остановить очередь? Работающие задания доработают, новые не начнутся, пока вы её не продолжите.";
const STATE_DOT: Record<QueueState, string> = {
	offline: "",
	paused: "dot--paused",
	ready: "dot--running",
	stopped: "dot--crashed",
	working: "dot--running",
};
const RESOURCE_WORDS: Record<NonNullable<QueueJob["resource"]>, string> = {
	cpu: "CPU",
	gpu: "GPU",
};

type Press = (event: MouseEvent<HTMLButtonElement>) => Promise<void>;

export const readQueue = async (): Promise<QueueView | null> =>
	(await readHub<{ queue: QueueView | null }>("/api/queue")).queue;

/** The queue as the hub reads it now: asked every few seconds while the page is looked at, and on demand. */
function useQueueReading() {
	const [queue, setQueue] = useState<QueueView | null>(null);
	const [available, setAvailable] = useState(false);
	const [receivedAt, setReceivedAt] = useState<number | null>(null);
	const asked = useRef(0);
	const refresh = useCallback(() => {
		asked.current += 1;
		const question = asked.current;
		readQueue()
			.then((next) => {
				// An answer overtaken by a later question would bring the old state back.
				if (question === asked.current) {
					setQueue(next);
					setAvailable(true);
					setReceivedAt(Date.now());
				}
			})
			.catch(() => {
				if (question === asked.current) {
					setAvailable(false);
				}
			});
	}, []);
	useEffect(() => {
		const ask = () => {
			if (document.visibilityState === "visible") {
				refresh();
			}
		};
		ask();
		const timer = setInterval(ask, POLL_MS);
		document.addEventListener("visibilitychange", ask);
		return () => {
			asked.current += 1;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", ask);
		};
	}, [refresh]);
	return { available, queue, receivedAt, refresh };
}

const QueueContext = createContext<ReturnType<typeof useQueueReading>>({
	available: false,
	queue: null,
	receivedAt: null,
	refresh: () => undefined,
});

/** One reading for the persistent header and the overview, including refreshes after queue actions. */
export function QueueProvider({ children }: { children: ReactNode }) {
	const reading = useQueueReading();
	return <QueueContext value={reading}>{children}</QueueContext>;
}

export const useQueue = () => useContext(QueueContext);

/** Megabytes as gibibytes with one decimal, the way the video card's memory is spoken of. */
const gib = (mb: number): string =>
	(mb / 1024).toLocaleString("ru-RU", {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
	});

const share = (part: number, whole: number): number =>
	whole > 0 ? part / whole : 0;

function Meter({
	label,
	part,
	title,
	words,
}: {
	label: string;
	/** From 0 to 1. */
	part: number;
	title?: string;
	words: string;
}) {
	const width = Math.min(100, Math.max(0, Math.round(part * 100)));
	return (
		<div className="meter" title={title}>
			<span className="muted small">{label}</span>
			<svg
				aria-hidden="true"
				className="meter__bar"
				preserveAspectRatio="none"
				viewBox="0 0 100 1"
			>
				<rect
					className={cx("meter__fill", width >= 90 && "meter__fill--high")}
					height="1"
					width={width}
				/>
			</svg>
			<span className="small">{words}</span>
		</div>
	);
}

export function QueueMeters({ queue }: { queue: QueueView }) {
	const { gpu, host } = queue;
	if (!(gpu || host)) {
		return null;
	}
	return (
		<div className="queue__meters">
			{gpu ? (
				<>
					<Meter
						label="GPU"
						part={gpu.utilization / 100}
						title={gpu.name}
						words={`${Math.round(gpu.utilization)}% · ${Math.round(gpu.temperature)} °C`}
					/>
					<Meter
						label="Видеопамять"
						part={share(gpu.usedMb, gpu.totalMb)}
						title={gpu.name}
						words={`${gib(gpu.usedMb)} из ${gib(gpu.totalMb)} ГБ`}
					/>
				</>
			) : null}
			{host ? (
				<>
					<Meter
						label="Память"
						part={share(host.totalMb - host.availableMb, host.totalMb)}
						words={`свободно ${gib(host.availableMb)} из ${gib(host.totalMb)} ГБ`}
					/>
					<Meter
						label="CPU"
						part={host.cpu / 100}
						words={`${Math.round(host.cpu)}%`}
					/>
				</>
			) : null}
		</div>
	);
}

const jobWords = (job: QueueJob): string =>
	[
		job.resource ? RESOURCE_WORDS[job.resource] : "",
		job.startedAt === null ? "" : since(job.startedAt),
	]
		.filter(Boolean)
		.join(" · ");

function Jobs({ queue }: { queue: QueueView }) {
	// Why nothing runs matters only while nothing does.
	const reason = queue.jobs.length === 0 ? queue.waitingFor[0] : undefined;
	return (
		<>
			{queue.jobs.length > 0 ? (
				<ul className="card__services">
					{queue.jobs.map((job) => (
						<li className="card__service" key={job.id}>
							<span className="dot dot--running" />
							<span className="queue__job">
								{job.private ? "Анонимное задание" : job.name}
								<JobProgress progress={job.progress} />
							</span>
							<span className="muted small">{jobWords(job)}</span>
						</li>
					))}
				</ul>
			) : null}
			{queue.queued !== null && queue.queued > 0 ? (
				<p className="muted small">В очереди: {queue.queued}</p>
			) : null}
			{reason ? <p className="muted small">{reason}</p> : null}
		</>
	);
}

/** The same rules as in the tray: no stop for a stopped queue, a pause or a continue, nothing while it is silent. */
function QueueButtons({
	pending,
	press,
	state,
}: {
	pending: string | null;
	press: Press;
	state: QueueState;
}) {
	if (state === "offline") {
		return null;
	}
	const held = state === "paused" || state === "stopped";
	return (
		<>
			{state === "stopped" ? null : (
				<button
					className="button button--small"
					data-confirm={STOP_QUESTION}
					data-path={STOP}
					disabled={pending !== null}
					onClick={press}
					type="button"
				>
					{pending === STOP ? "Останавливаю…" : "Стоп очереди"}
				</button>
			)}
			{held ? (
				<button
					className="button button--small"
					data-path={CONTINUE}
					disabled={pending !== null}
					onClick={press}
					title="Очередь снова берёт задания"
					type="button"
				>
					{pending === CONTINUE ? "Продолжаю…" : "Продолжить"}
				</button>
			) : (
				<button
					className="button button--small"
					data-path={PAUSE}
					disabled={pending !== null}
					onClick={press}
					title="Работающие задания доработают, новые подождут"
					type="button"
				>
					Пауза
				</button>
			)}
		</>
	);
}

function Offline({
	pending,
	press,
	service,
	status,
}: {
	pending: string | null;
	press: Press;
	service: string;
	status: ServiceStatus | null;
}) {
	const start = `/api/services/${service}/start`;
	// Only a service that is down can be started; one whose port answers nothing needs a look at its page.
	const down = status === "stopped" || status === "crashed";
	return (
		<p className="warn queue__offline">
			<span>
				{status === "starting"
					? "Очередь запускается и пока не отвечает."
					: "Очередь не отвечает."}
			</span>
			{down ? (
				<button
					className="button button--small"
					data-path={start}
					disabled={pending !== null}
					onClick={press}
					type="button"
				>
					{pending === start ? "Запускаю…" : "Запустить"}
				</button>
			) : null}
		</p>
	);
}

function executorDot(executor: QueueExecutor): string {
	if (executor.error) {
		return "dot--crashed";
	}
	if (!executor.accepting) {
		return "";
	}
	return executor.connected ? "dot--running" : "dot--starting";
}

function Executor({
	executor,
	pending,
	press,
	toggle,
}: {
	executor: QueueExecutor;
	pending: string | null;
	press: Press;
	toggle: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
}) {
	const address = `/api/queue/executors/${executor.id}`;
	const accept = executor.acceptOnStart;
	// The executor's own words usually carry its trouble already.
	const problem =
		executor.error &&
		!executor.label.includes(executor.error) &&
		!executor.note.includes(executor.error)
			? executor.error
			: null;
	return (
		<li className="queue__executor">
			<div className="queue__executor-title">
				<div className="queue__executor-head">
					<span className={cx("dot", executorDot(executor))} />
					<strong>{executor.name}</strong>
					<span className="muted small">{executor.label}</span>
				</div>
				{executor.note ? <p className="muted small">{executor.note}</p> : null}
				{problem ? <p className="queue__problem small">{problem}</p> : null}
			</div>
			<div className="queue__executor-actions">
				{executor.commands.map((command) => (
					<button
						className="button button--small"
						data-path={`${address}/${command.id}`}
						disabled={!command.enabled || pending !== null}
						key={command.id}
						onClick={press}
						title={command.text}
						type="button"
					>
						{command.short}
					</button>
				))}
				{accept ? (
					<label className="queue__check small">
						<input
							checked={accept.enabled}
							data-path={`${address}/${accept.enabled ? "accept-off" : "accept-on"}`}
							disabled={pending !== null}
							onChange={toggle}
							type="checkbox"
						/>
						{accept.text}
					</label>
				) : null}
			</div>
		</li>
	);
}

export function QueueCard({
	onAction,
	queue,
	status,
}: {
	/** Called after every command, so the card shows what it changed without waiting for the next reading. */
	onAction: () => void;
	queue: QueueView;
	/** The queue's service as the hub sees it, to offer starting one that is down. */
	status: ServiceStatus | null;
}) {
	const { dialog, error, pending, run, send } = useAction();
	const press = useCallback(
		async (event: MouseEvent<HTMLButtonElement>) => {
			await run(event);
			onAction();
		},
		[onAction, run]
	);
	const toggle = useCallback(
		async (event: ChangeEvent<HTMLInputElement>) => {
			const { path } = event.currentTarget.dataset;
			if (path) {
				await send(path);
				onAction();
			}
		},
		[onAction, send]
	);
	const executors = (queue.executors ?? []).filter(
		(executor) => executor.paired
	);
	return (
		<article className="card queue">
			<header className="card__head">
				<div className="card__title">
					<h2>
						<span className={cx("dot", STATE_DOT[queue.state])} /> Общая очередь
					</h2>
					<p className="muted small">{queue.label}</p>
				</div>
				<div className="card__actions">
					<QueueButtons pending={pending} press={press} state={queue.state} />
					<a className="button button--small" href={queue.panel}>
						Панель очереди
					</a>
				</div>
			</header>
			{queue.state === "offline" ? (
				<Offline
					pending={pending}
					press={press}
					service={queue.service}
					status={status}
				/>
			) : null}
			<QueueMeters queue={queue} />
			<Jobs queue={queue} />
			{executors.length > 0 ? (
				<ul className="queue__executors">
					{executors.map((executor) => (
						<Executor
							executor={executor}
							key={executor.id}
							pending={pending}
							press={press}
							toggle={toggle}
						/>
					))}
				</ul>
			) : null}
			{error ? <p className="error small">{error}</p> : null}
			{dialog}
		</article>
	);
}

/** The queue's place on the overview; nothing when no project on this computer declares a queue. */
export function QueueSection({ view }: { view: HubView }) {
	const { queue, refresh } = useQueue();
	if (!queue) {
		return null;
	}
	const status =
		view.projects
			.flatMap((project) => project.services)
			.find((service) => service.key === queue.service)?.status ?? null;
	return (
		<section>
			<QueueCard onAction={refresh} queue={queue} status={status} />
		</section>
	);
}
