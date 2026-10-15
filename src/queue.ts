import { readFile } from "node:fs/promises";

import {
	type Catalogue,
	queueTokenFile,
	type Service,
	servicesOf,
} from "./config";

/**
 * The hub's line to this computer's shared GPU/CPU queue. Two catalogued services declare it (`queue` in their
 * manifest): the queue itself and the host of its remote executors. The hub reads their state for its page and its
 * tray, and passes on the few commands their owner gives there. The API token is read from the project's own file
 * on every request and goes only to that service on this computer. A queue that is silent, starting or broken is
 * never an error here: it is the state "offline".
 *
 * Job progress is a bounded numeric observation with known phase labels. Commands, workflows, results and
 * errors never pass through: jobs can be private.
 */

export type QueueState = "ready" | "working" | "paused" | "stopped" | "offline";

export interface QueueProgress {
	percent: number | null;
	phase: string;
	phaseTitle: string;
	scope: "node" | "stage" | "job";
	step: number | null;
	totalSteps: number | null;
	/** Milliseconds since the epoch, or null when no observation time is known. */
	updatedAt: number | null;
}

export interface QueueJob {
	/** An active cancellation was already requested; absent before any request. */
	cancelRequested?: boolean;
	id: string;
	name: string;
	private: boolean;
	progress?: QueueProgress;
	resource: "gpu" | "cpu" | null;
	/** Milliseconds since the epoch, like every other time on the page. */
	startedAt: number | null;
}

/** Selected job diagnostics, with operational fields only; no command, workflow, output text or private key. */
export interface QueueJobDetails {
	cancelRequested: boolean;
	cpuThreads: number | null;
	createdAt: number | null;
	expectedSeconds: number | null;
	finishedAt: number | null;
	gpuCompute: number | null;
	id: string;
	outputBytes: number | null;
	peakRamMb: number | null;
	peakVramMb: number | null;
	pid: number | null;
	position: number | null;
	priority: number | null;
	profile: string | null;
	progress?: QueueProgress;
	queuedSeconds: number | null;
	quietSeconds: number | null;
	ramMb: number | null;
	resource: "gpu" | "cpu" | null;
	runningSeconds: number | null;
	startedAt: number | null;
	state: string;
	vramMb: number | null;
	waitingFor: string | null;
}

export interface QueueExecutorCommand {
	enabled: boolean;
	id: "enable" | "pause" | "stop";
	/** The wording for a button beside the executor's name. */
	short: string;
	/** The full wording for a menu, with the executor's name in it. */
	text: string;
}

export interface QueueExecutor {
	accepting: boolean;
	acceptOnStart: { enabled: boolean; text: string } | null;
	attached: boolean;
	busy: boolean;
	commands: QueueExecutorCommand[];
	connected: boolean;
	error: string;
	id: string;
	/** Its state in words. */
	label: string;
	name: string;
	/** A second line: the last result, or what the executor is for. */
	note: string;
	paired: boolean;
	site: string | null;
}

export interface QueueView {
	/** Null when the executors' host is not declared or does not answer. */
	executors: QueueExecutor[] | null;
	executorsService: string | null;
	gpu: {
		name: string;
		temperature: number;
		totalMb: number;
		usedMb: number;
		utilization: number;
	} | null;
	host: { availableMb: number; cpu: number; totalMb: number } | null;
	jobs: QueueJob[];
	label: string;
	/** The hub route of the queue's own page. */
	panel: string;
	/** How many jobs wait; null when the running queue is too old to say. */
	queued: number | null;
	/** Waiting jobs in the scheduler's order; null when their listing does not answer. */
	queuedJobs: QueueJob[] | null;
	/** How many jobs run now; the queue may count more than it lists. */
	running: number;
	service: string;
	/** `stopped` is the owner's stop and wins over a pause. */
	state: QueueState;
	waitingFor: string[];
}

export type TrayItem =
	| { separator: true }
	| {
			checked?: boolean;
			enabled: boolean;
			/** A page to open in the browser. */
			open?: string;
			/** A hub action to send. */
			post?: string;
			text: string;
	  };

/** The queue's part of the tray menu, ready to draw: the tray program knows nothing about the queue. */
export interface TrayMenu {
	items: TrayItem[];
	/** A few words for the icon's tooltip. */
	tip: string;
}

export interface QueueRuntime {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** How long one reading serves the page and the tray, which ask at the same moments. */
	freshMs?: number;
	readFile?: (path: string) => Promise<string>;
}

const READ_TIMEOUT_MS = 1500;
/** A command may wait for the queue's own bookkeeping: longer than a reading, still short of a hung button. */
const ACTION_TIMEOUT_MS = 5000;
const FRESH_MS = 1000;
const ANONYMOUS = "Анонимное задание";
const NAME_LIMIT = 200;
const EXECUTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JOB_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The token never leaves this computer, whatever host a manifest names. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MENTIONS_QUEUE = /очеред/i;

const QUEUE_ACTIONS: Record<string, string> = {
	continue: "/api/queue/continue",
	pause: "/api/pause",
	resume: "/api/resume",
	stop: "/api/queue/stop",
};
const EXECUTOR_COMMANDS = new Set(["enable", "pause", "stop"]);
const ACCEPT_ON_START: Record<string, boolean> = {
	"accept-off": false,
	"accept-on": true,
};

const STATE_WORDS: Record<Exclude<QueueState, "working">, string> = {
	offline: "Нет связи с очередью",
	paused: "Очередь на паузе",
	ready: "Общая очередь готова",
	stopped: "Очередь остановлена",
};
const TIP_WORDS: Record<Exclude<QueueState, "working">, string> = {
	offline: "нет связи",
	paused: "на паузе",
	ready: "готова",
	stopped: "остановлена",
};

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
	typeof value === "string" ? value : "";
const amount = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/** An upstream refusal keeps its HTTP status when shown by a protected hub reading. */
export class QueueError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "QueueError";
		this.status = status;
	}
}

const milliseconds = (value: unknown): number | null => {
	const seconds = amount(value);
	return seconds === null ? null : Math.round(seconds * 1000);
};

const PROGRESS_PHASES: Record<string, string> = {
	cancelled: "Отменено",
	collecting: "Сохранение результата",
	conditioning: "Подготовка сцены",
	decode: "Декодирование",
	failed: "Ошибка",
	interrupted: "Прервано",
	loading: "Загрузка модели",
	needs_attention: "Нужна проверка",
	queued: "В очереди",
	refinement: "Уточнение изображения",
	running: "Выполняется",
	sampling: "Генерация",
	saving: "Сохранение результата",
	succeeded: "Готово",
};

/** No upstream strings are displayed: even a private job's forged title stays private. */
function progressOf(value: unknown): QueueProgress | undefined {
	const raw = record(value);
	if (!raw) {
		return undefined;
	}
	const phase = Object.hasOwn(PROGRESS_PHASES, text(raw.phase))
		? text(raw.phase)
		: "running";
	const scope =
		raw.scope === "node" || raw.scope === "job" ? raw.scope : "stage";
	const measuredScope =
		raw.scope === "node" || raw.scope === "stage" || raw.scope === "job";
	const percent = amount(raw.percent);
	const step = amount(raw.step),
		total = amount(raw.total_steps);
	const stepsValid =
		step !== null &&
		total !== null &&
		Number.isInteger(step) &&
		Number.isInteger(total) &&
		step >= 0 &&
		total > 0 &&
		step <= total &&
		total <= 1_000_000;
	const updated = amount(raw.updated_at);
	return {
		percent:
			measuredScope && percent !== null && percent >= 0 && percent <= 100
				? percent
				: null,
		phase,
		phaseTitle: PROGRESS_PHASES[phase] ?? "Выполняется",
		scope,
		step: measuredScope && stepsValid ? step : null,
		totalSteps: measuredScope && stepsValid ? total : null,
		updatedAt:
			updated !== null &&
			updated >= 0 &&
			updated <= Number.MAX_SAFE_INTEGER / 1000
				? milliseconds(updated)
				: null,
	};
}

function jobDetailsOf(value: unknown, id: string): QueueJobDetails {
	const job = record(record(value)?.job);
	if (!job || text(job.id).toLowerCase() !== id.toLowerCase()) {
		throw new QueueError("Очередь не вернула сведения о задании", 502);
	}
	if (job.private === true) {
		throw new QueueError("Задание не найдено", 404);
	}
	const decision = record(job.decision);
	const allocation = record(job.allocation) ?? record(decision?.estimate);
	const metrics = record(job.metrics);
	const output = record(job.output);
	const waiting =
		text(record(decision?.wait)?.summary) ||
		text(record(decision?.recovery)?.summary) ||
		list(decision?.waiting_for)
			.flatMap((reason) => (typeof reason === "string" ? [reason] : []))
			.join(" · ");
	const resource = job.resource ?? allocation?.resource;
	const progress = progressOf(job.progress);
	return {
		cancelRequested: job.cancel === true || job.cancel === 1,
		cpuThreads: amount(allocation?.cpu_threads),
		createdAt: milliseconds(job.created),
		expectedSeconds: amount(allocation?.expected_seconds),
		finishedAt: milliseconds(job.finished),
		gpuCompute: amount(allocation?.gpu_compute_pct),
		id: text(job.id),
		outputBytes: amount(output?.bytes),
		peakRamMb: amount(metrics?.peak_ram_mb),
		peakVramMb: amount(metrics?.peak_vram_mb),
		pid: amount(job.pid),
		position: amount(decision?.position),
		priority: amount(job.priority),
		profile: text(job.profile).slice(0, NAME_LIMIT) || null,
		...(progress ? { progress } : {}),
		queuedSeconds: amount(job.queued_seconds),
		quietSeconds: amount(output?.quiet_seconds),
		ramMb: amount(allocation?.ram_mb),
		resource: resource === "gpu" || resource === "cpu" ? resource : null,
		runningSeconds: amount(job.running_seconds),
		startedAt: milliseconds(job.started),
		state: text(job.state).slice(0, 40) || "unknown",
		vramMb: amount(allocation?.vram_mb),
		waitingFor: waiting.slice(0, 600) || null,
	};
}

function jobOf(value: unknown): QueueJob[] {
	const job = record(value);
	const id = text(job?.id);
	if (!(job && id)) {
		return [];
	}
	const hidden = job.private === true;
	const resource = record(job.spec)?.resource;
	const started = amount(job.started);
	const progress = progressOf(job.progress);
	return [
		{
			...(job.cancel === true || job.cancel === 1
				? { cancelRequested: true }
				: {}),
			id,
			// A private job is never named here, even by a queue that still sends its name.
			name: hidden ? ANONYMOUS : text(job.name).slice(0, NAME_LIMIT) || id,
			private: hidden,
			...(progress ? { progress } : {}),
			resource: resource === "gpu" || resource === "cpu" ? resource : null,
			startedAt: started === null ? null : Math.round(started * 1000),
		},
	];
}

/** The cached scheduler plan also includes jobs it has just launched; they are already in the active list. */
function queuedJobsOf(
	value: unknown,
	status: Json | null,
	active: QueueJob[]
): QueueJob[] | null {
	if (!status) {
		return null;
	}
	if (amount(status.queued_count) === 0) {
		return [];
	}
	const planned = record(value)?.jobs;
	if (!Array.isArray(planned)) {
		return null;
	}
	const seen = new Set(active.map((job) => job.id));
	return planned.flatMap((entry) => {
		const row = record(entry);
		const id = text(row?.job_id);
		if (!row || row.launched === true || seen.has(id)) {
			return [];
		}
		const jobs = jobOf({
			id,
			name: row.name,
			// The queue itself anonymizes a plan row and need not send a private flag with it.
			private: row.private === true || row.name === ANONYMOUS,
			spec: row.estimate,
		});
		if (jobs.length > 0) {
			seen.add(id);
		}
		return jobs;
	});
}

function gpuOf(value: unknown): QueueView["gpu"] {
	const gpu = record(value);
	const total = amount(gpu?.total_mb);
	const free = amount(gpu?.free_mb);
	const utilization = amount(gpu?.utilization);
	const temperature = amount(gpu?.temperature);
	if (
		!gpu ||
		total === null ||
		free === null ||
		utilization === null ||
		temperature === null
	) {
		return null;
	}
	return {
		name: text(gpu.name),
		temperature,
		totalMb: total,
		usedMb: Math.max(0, total - free),
		utilization,
	};
}

function hostOf(value: unknown): QueueView["host"] {
	const host = record(value);
	const total = amount(host?.total_mb);
	const available = amount(host?.available_mb);
	const cpu = amount(host?.cpu_utilization);
	return total === null || available === null || cpu === null
		? null
		: { availableMb: available, cpu, totalMb: total };
}

function commandOf(value: unknown): QueueExecutorCommand[] {
	const command = record(value);
	const id = text(command?.id);
	if (!(command && (id === "enable" || id === "pause" || id === "stop"))) {
		return [];
	}
	const words = text(command.text);
	return [
		{
			enabled: command.enabled === true,
			id,
			short: text(command.short) || words || id,
			text: words || text(command.short) || id,
		},
	];
}

function executorOf(value: unknown): QueueExecutor[] {
	const executor = record(value);
	const id = text(executor?.id);
	// The id becomes part of an address: one that could not be is not an executor to steer.
	if (!(executor && EXECUTOR_ID.test(id))) {
		return [];
	}
	const accept = record(executor.accept_on_start);
	return [
		{
			accepting: executor.accepting === true,
			acceptOnStart: accept
				? { enabled: accept.enabled === true, text: text(accept.text) }
				: null,
			attached: executor.attached === true,
			busy: executor.busy === true,
			commands: list(executor.commands).flatMap(commandOf),
			connected: executor.connected === true,
			error: text(executor.error),
			id,
			label: text(executor.label),
			name: text(executor.name) || id,
			note: text(executor.note),
			paired: executor.paired === true,
			site: typeof executor.site === "string" ? executor.site : null,
		},
	];
}

function stateOf(status: Json | null, running: number): QueueState {
	if (!status) {
		return "offline";
	}
	if (status.stopped === true) {
		return "stopped";
	}
	if (status.paused === true) {
		return "paused";
	}
	return running > 0 ? "working" : "ready";
}

const gpuWords = (gpu: QueueView["gpu"]): string =>
	gpu ? ` · GPU ${Math.round(gpu.utilization)}%` : "";

/** The queue as the page and the tray show it, from what its two services answered (null: no answer). */
export function queueView(
	services: { executors: string | null; queue: string },
	answer: unknown,
	executors: unknown,
	plan: unknown = null
): QueueView {
	const status = record(answer);
	const jobs = list(status?.active_jobs).flatMap(jobOf);
	const running = Math.max(amount(status?.active_count) ?? 0, jobs.length);
	const state = stateOf(status, running);
	const gpu = gpuOf(status?.gpu);
	const words =
		state === "working" ? `Выполняется: ${running}` : STATE_WORDS[state];
	return {
		executors: Array.isArray(executors) ? executors.flatMap(executorOf) : null,
		executorsService: services.executors,
		gpu,
		host: hostOf(status?.host),
		jobs,
		label: `${words}${gpuWords(gpu)}`,
		panel: `#/${services.queue}`,
		queued: amount(status?.queued_count),
		queuedJobs: queuedJobsOf(plan, status, jobs),
		running,
		service: services.queue,
		state,
		waitingFor: list(status?.waiting_for).flatMap((reason) =>
			typeof reason === "string" && reason ? [reason] : []
		),
	};
}

function executorItems(executor: QueueExecutor): TrayItem[] {
	const address = `/api/queue/executors/${executor.id}`;
	const items: TrayItem[] = [
		{ separator: true },
		{ enabled: false, text: `${executor.name} · ${executor.label}` },
	];
	if (executor.note) {
		items.push({ enabled: false, text: executor.note });
	}
	for (const command of executor.commands) {
		items.push({
			enabled: command.enabled,
			post: `${address}/${command.id}`,
			text: command.text,
		});
	}
	if (executor.acceptOnStart) {
		items.push({
			checked: executor.acceptOnStart.enabled,
			enabled: true,
			post: `${address}/${executor.acceptOnStart.enabled ? "accept-off" : "accept-on"}`,
			text: executor.acceptOnStart.text,
		});
	}
	return items;
}

/**
 * The queue's part of the tray menu. Its wording is the owner's: the stop, pause and continue items are named in
 * the rules agents follow, and must stay as they are.
 */
export function trayMenu(view: QueueView | null, hubUrl: string): TrayMenu {
	if (!view) {
		return { items: [], tip: "" };
	}
	const offline = view.state === "offline";
	const stopped = view.state === "stopped";
	const held = stopped || view.state === "paused";
	const items: TrayItem[] = [
		{
			enabled: false,
			text: MENTIONS_QUEUE.test(view.label)
				? view.label
				: `Общая очередь · ${view.label}`,
		},
		{
			enabled: true,
			open: new URL(view.panel, hubUrl).href,
			text: "Открыть общую очередь",
		},
		{
			enabled: !(offline || stopped),
			post: "/api/queue/stop",
			text: "Стоп общей очереди",
		},
		{
			enabled: !(offline || held),
			post: "/api/queue/pause",
			text: "Пауза общей очереди",
		},
		{
			enabled: held,
			post: "/api/queue/continue",
			text: "Продолжить общую очередь",
		},
	];
	for (const executor of view.executors ?? []) {
		if (executor.paired) {
			items.push(...executorItems(executor));
		}
	}
	const words =
		view.state === "working"
			? `выполняется ${view.running}`
			: TIP_WORDS[view.state];
	return { items, tip: `очередь: ${words}${gpuWords(view.gpu)}` };
}

export class Queue {
	private readonly catalogue: () => Catalogue;
	private readonly runtime: Required<QueueRuntime>;
	private reading: { at: number; view: Promise<QueueView | null> } | null =
		null;

	constructor(catalogue: () => Catalogue, runtime: QueueRuntime = {}) {
		this.catalogue = catalogue;
		this.runtime = {
			fetch: (url, init) => fetch(url, init),
			freshMs: FRESH_MS,
			readFile: (path) => readFile(path, "utf8"),
			...runtime,
		};
	}

	private service(role: "queue" | "executors"): Service | undefined {
		return servicesOf(this.catalogue()).find(
			(service) => service.queue?.role === role
		);
	}

	private async token(service: Service): Promise<string> {
		const file = queueTokenFile(service);
		if (!file) {
			return "";
		}
		try {
			return (await this.runtime.readFile(file)).trim();
		} catch {
			// The service writes it when it first starts.
			return "";
		}
	}

	private async request(
		service: Service,
		path: string,
		options: { body?: unknown; method: "GET" | "POST"; timeoutMs: number }
	): Promise<unknown> {
		if (!(service.port && LOOPBACK.has(service.host))) {
			throw new Error(
				`${service.key}: нужен порт на этом компьютере, чтобы говорить с очередью`
			);
		}
		const token = await this.token(service);
		if (!token) {
			throw new Error(
				`${service.key} ещё не запускался: у него нет токена для пульта`
			);
		}
		const sending = options.body !== undefined;
		let response: Response;
		try {
			response = await this.runtime.fetch(
				`http://${service.host}:${service.port}${path}`,
				{
					body: sending ? JSON.stringify(options.body) : undefined,
					headers: {
						Authorization: `Bearer ${token}`,
						...(sending ? { "Content-Type": "application/json" } : {}),
					},
					method: options.method,
					signal: AbortSignal.timeout(options.timeoutMs),
				}
			);
		} catch (error) {
			throw new Error(`${service.key} не отвечает`, { cause: error });
		}
		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const detail = text(record(body)?.detail);
			throw new QueueError(
				detail || `${service.key} ответил HTTP ${response.status}`,
				response.status
			);
		}
		return body;
	}

	private async read(): Promise<QueueView | null> {
		const queue = this.service("queue");
		if (!queue) {
			return null;
		}
		const executors = this.service("executors");
		const reading = { method: "GET", timeoutMs: READ_TIMEOUT_MS } as const;
		const [status, hosted, plan] = await Promise.all([
			this.request(queue, "/api/status", reading).catch(() => null),
			executors
				? this.request(executors, "/api/executors", reading).catch(() => null)
				: null,
			// This endpoint returns the scheduler's cached plan, without running a scheduler tick.
			this.request(queue, "/api/queue-plan", reading).catch(() => null),
		]);
		return queueView(
			{ executors: executors?.key ?? null, queue: queue.key },
			status,
			hosted,
			plan
		);
	}

	/** The queue now; null when no service declares it. One reading serves everyone who asks within a second. */
	view(): Promise<QueueView | null> {
		const now = Date.now();
		if (this.reading && now - this.reading.at < this.runtime.freshMs) {
			return this.reading.view;
		}
		const view = this.read();
		this.reading = { at: now, view };
		return view;
	}

	async tray(hubUrl: string): Promise<TrayMenu> {
		return trayMenu(await this.view(), hubUrl);
	}

	/** Selected-job diagnostics only: reading the raw job endpoint would renew its client's lease. */
	async job(id: string): Promise<QueueJobDetails> {
		if (!JOB_ID.test(id)) {
			throw new QueueError("Неверный ID задания", 400);
		}
		const service = this.service("queue");
		if (!service) {
			throw new QueueError("общая очередь не подключена", 409);
		}
		const answer = await this.request(service, `/api/jobs/${id}/diagnostics`, {
			method: "GET",
			timeoutMs: READ_TIMEOUT_MS,
		});
		return jobDetailsOf(answer, id);
	}

	/** A queued cancellation must remain safe even if the scheduler starts it before this request arrives. */
	cancelJob(id: string, state: unknown): Promise<void> {
		if (!JOB_ID.test(id)) {
			return Promise.reject(new QueueError("Неверный ID задания", 400));
		}
		if (state !== "queued" && state !== "running") {
			return Promise.reject(
				new QueueError("Нужно состояние задания queued или running", 400)
			);
		}
		return this.send(
			"queue",
			`/api/jobs/${id}/cancel?require_unstarted=${state === "queued"}`
		);
	}

	private async send(
		role: "queue" | "executors",
		path: string,
		body?: unknown
	): Promise<void> {
		const service = this.service(role);
		if (!service) {
			throw new Error(
				role === "queue"
					? "общая очередь не подключена: её не объявляет ни один сервис"
					: "исполнители очереди не подключены: их не объявляет ни один сервис"
			);
		}
		try {
			await this.request(service, path, {
				body,
				method: "POST",
				timeoutMs: ACTION_TIMEOUT_MS,
			});
		} finally {
			// Whoever asks next sees what the command changed.
			this.reading = null;
		}
	}

	/** Pause, resume (lifts a pause only), the owner's stop and continue. */
	act(action: string): Promise<void> {
		const path = QUEUE_ACTIONS[action];
		if (!path) {
			return Promise.reject(new Error(`неизвестное действие ${action}`));
		}
		return this.send("queue", path);
	}

	/** An executor's own commands, and whether it takes orders as soon as it starts. */
	executor(id: string, action: string): Promise<void> {
		if (!EXECUTOR_ID.test(id)) {
			return Promise.reject(new Error(`нет исполнителя ${id}`));
		}
		const address = `/api/executors/${encodeURIComponent(id)}`;
		if (EXECUTOR_COMMANDS.has(action)) {
			return this.send("executors", `${address}/${action}`);
		}
		const enabled = ACCEPT_ON_START[action];
		if (enabled === undefined) {
			return Promise.reject(new Error(`неизвестное действие ${action}`));
		}
		return this.send("executors", `${address}/accept-on-start`, { enabled });
	}
}
