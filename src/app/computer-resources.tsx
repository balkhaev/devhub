import type { QueueView } from "../queue";
import { useQueue } from "./queue";
import { cx } from "./words";

const STALE_MS = 15_000;
const QUEUE_WORDS = {
	offline: "Нет связи",
	paused: "На паузе",
	ready: "Ожидание",
	stopped: "Остановлена",
	working: "В работе",
};

const gib = (mb: number): string =>
	(mb / 1024).toLocaleString("ru-RU", {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
	});

function percent(value: number | undefined): number | null {
	return value !== undefined &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value
		: null;
}

function memory(total: number | undefined, used: number | undefined) {
	if (
		total === undefined ||
		used === undefined ||
		!Number.isFinite(total) ||
		!Number.isFinite(used) ||
		total <= 0 ||
		used < 0 ||
		used > total
	) {
		return null;
	}
	return { free: total - used, part: (used / total) * 100, total, used };
}

function ResourceCard({
	detail,
	label,
	meterLabel = label,
	part,
	tag,
	tone,
	value,
}: {
	detail: string;
	label: string;
	meterLabel?: string;
	part: number | null;
	tag: string;
	tone: string;
	value: string;
}) {
	return (
		<article className={`resource-card resource-card--${tone}`}>
			<div className="resource-card__head">
				<h3>{label}</h3>
				<span>{tag}</span>
			</div>
			<strong className="resource-card__value">{value}</strong>
			<p title={detail}>{detail}</p>
			{part === null ? (
				<div aria-hidden="true" className="resource-card__empty-bar" />
			) : (
				<progress
					aria-label={meterLabel}
					className={cx(
						"resource-card__bar",
						part >= 90 && "resource-card__bar--high"
					)}
					max={100}
					value={part}
				/>
			)}
		</article>
	);
}

function readingState({
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
	const stale = receivedAt !== null && now - receivedAt > STALE_MS;
	const fresh = receivedAt !== null && !stale;
	const current =
		available && fresh && queue?.state !== "offline" ? queue : null;
	const hasReadings = Boolean(current?.gpu || current?.host);
	const received =
		receivedAt === null
			? null
			: new Date(receivedAt).toLocaleTimeString("ru-RU");
	let freshness = "Ожидаем данные Inference";
	if (hasReadings) {
		freshness = `Получено в ${received ?? "—"}`;
	} else if (stale) {
		freshness = "Данные устарели";
	} else if (receivedAt !== null) {
		freshness = "Нет актуальных данных";
	}
	return { current, freshness, hasReadings, received };
}

/** receivedAt is the receipt time, never an invented upstream sensor timestamp. */
export function ComputerResources(props: {
	available: boolean;
	now?: number;
	queue: QueueView | null;
	receivedAt: number | null;
}) {
	const { current, freshness, hasReadings, received } = readingState(props);
	const gpu = current?.gpu;
	const host = current?.host;
	const gpuLoad = percent(gpu?.utilization);
	const cpuLoad = percent(host?.cpu);
	const vram = memory(gpu?.totalMb, gpu?.usedMb);
	const ram = memory(
		host?.totalMb,
		host ? host.totalMb - host.availableMb : undefined
	);
	const temperature =
		gpu && Number.isFinite(gpu.temperature) && gpu.temperature >= 0
			? ` · ${Math.round(gpu.temperature)} °C`
			: "";
	const gpuValue = gpuLoad === null ? "—" : `${Math.round(gpuLoad)}%`;
	return (
		<section
			aria-labelledby="computer-resources-title"
			className="computer-resources"
		>
			<div className="computer-resources__head">
				<h2 id="computer-resources-title">Ресурсы компьютера</h2>
				<div
					className={cx(
						"computer-resources__freshness",
						hasReadings && "computer-resources__freshness--live"
					)}
				>
					<span aria-hidden="true" />
					{freshness}
				</div>
			</div>
			<div className="computer-resources__grid">
				<ResourceCard
					detail={gpu?.name || "Нет данных о видеокарте"}
					label="Загрузка GPU"
					part={gpuLoad}
					tag="GPU"
					tone="gpu"
					value={`${gpuValue}${temperature}`}
				/>
				<ResourceCard
					detail={
						vram
							? `из ${gib(vram.total)} ГБ · свободно ${gib(vram.free)} ГБ`
							: "Нет данных о видеопамяти"
					}
					label="Видеопамять"
					part={vram?.part ?? null}
					tag="VRAM"
					tone="vram"
					value={vram ? `${gib(vram.used)} ГБ` : "—"}
				/>
				<ResourceCard
					detail={
						ram
							? `свободно из ${gib(ram.total)} ГБ · занято ${gib(ram.used)} ГБ`
							: "Нет данных об оперативной памяти"
					}
					label="Оперативная память"
					meterLabel="Занято оперативной памяти"
					part={ram?.part ?? null}
					tag="RAM"
					tone="ram"
					value={ram ? `${gib(ram.free)} ГБ` : "—"}
				/>
				<ResourceCard
					detail={
						current
							? `Общая очередь: ${QUEUE_WORDS[current.state].toLocaleLowerCase("ru-RU")}`
							: "Нет данных о процессоре"
					}
					label="Загрузка процессора"
					part={cpuLoad}
					tag="CPU"
					tone="cpu"
					value={cpuLoad === null ? "—" : `${Math.round(cpuLoad)}%`}
				/>
			</div>
			{!hasReadings && received ? (
				<p className="computer-resources__last">
					Последнее получение данных: {received}
				</p>
			) : null}
		</section>
	);
}

export function ResourceOverview() {
	const { available, queue, receivedAt } = useQueue();
	return (
		<ComputerResources
			available={available}
			queue={queue}
			receivedAt={receivedAt}
		/>
	);
}
