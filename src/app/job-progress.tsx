import type { QueueProgress } from "../queue";

const SCOPES = {
	job: "задания",
	node: "текущей операции",
	stage: "текущего этапа",
};

export function progressWords(progress: QueueProgress): string {
	return [
		progress.phaseTitle,
		progress.percent === null
			? null
			: `${progress.percent.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}% ${SCOPES[progress.scope]}`,
		progress.step === null || progress.totalSteps === null
			? null
			: `шаг ${progress.step} из ${progress.totalSteps}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Unknown measurements stay indeterminate; the meter never grows with elapsed time. */
export function JobProgress({ progress }: { progress?: QueueProgress }) {
	if (!progress) {
		return null;
	}
	const words = progressWords(progress);
	return (
		<span className="queue-progress">
			<span className="queue-progress__label">{words}</span>
			<progress
				aria-label={progress.phaseTitle}
				aria-valuetext={words}
				max={100}
				value={progress.percent ?? undefined}
			/>
		</span>
	);
}
