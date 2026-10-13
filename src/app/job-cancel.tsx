import {
	type MouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { QueueJob } from "../queue";
import { sendHub } from "./api";
import { useConfirm } from "./confirm";
import { useQueue } from "./queue";

export type CancelJobState = "queued" | "running";
type Pending = { id: string; phase: "confirming" | "sending" } | null;

export const canCancelJob = (
	state: string | null | undefined
): state is CancelJobState => state === "queued" || state === "running";

export async function cancelJob(
	id: string,
	state: CancelJobState
): Promise<void> {
	await sendHub<null>(`/api/queue/jobs/${encodeURIComponent(id)}/cancel`, {
		state,
	});
}

export function cancellationQuestion(
	job: QueueJob,
	state: CancelJobState
): string {
	const name = job.private ? "Анонимное задание" : job.name;
	const consequence =
		state === "running"
			? "Его выполнение будет остановлено."
			: "Ожидающее задание будет убрано из очереди.";
	return `Отменить задание «${name}» (${job.id.slice(0, 8)})? ${consequence}`;
}

export async function confirmJobCancellation(
	job: QueueJob,
	state: CancelJobState,
	confirm: (question: string) => Promise<boolean>,
	isCurrent: () => boolean,
	onSend: () => void
): Promise<boolean> {
	if (!((await confirm(cancellationQuestion(job, state))) && isCurrent())) {
		return false;
	}
	onSend();
	await cancelJob(job.id, state);
	return true;
}

/** A declined confirmation sends nothing; a duplicate click cannot start a second request. */
export function useJobCancellation() {
	const [confirm, dialog] = useConfirm();
	const { refresh } = useQueue();
	const lifecycle = useRef(new Set<"mounted" | "locked">());
	const [pending, setPending] = useState<Pending>(null);
	const [requested, setRequested] = useState<Set<string>>(() => new Set());
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	useEffect(() => {
		lifecycle.current.add("mounted");
		return () => {
			lifecycle.current.delete("mounted");
		};
	}, []);
	const cancel = useCallback(
		async (job: QueueJob, state: CancelJobState) => {
			if (lifecycle.current.has("locked") || job.cancelRequested) {
				return false;
			}
			lifecycle.current.add("locked");
			setPending({ id: job.id, phase: "confirming" });
			setError(null);
			setNotice(null);
			let sent = false;
			try {
				const cancelled = await confirmJobCancellation(
					job,
					state,
					confirm,
					() => lifecycle.current.has("mounted"),
					() => {
						setPending({ id: job.id, phase: "sending" });
						sent = true;
					}
				);
				if (!cancelled) {
					return false;
				}
				if (lifecycle.current.has("mounted")) {
					setRequested((current) => new Set([...current, job.id]));
					setNotice("Отмена запрошена.");
				}
				return lifecycle.current.has("mounted");
			} catch (problem) {
				if (lifecycle.current.has("mounted")) {
					setError((problem as Error).message);
				}
				return false;
			} finally {
				lifecycle.current.delete("locked");
				if (sent) {
					refresh();
				}
				if (lifecycle.current.has("mounted")) {
					setPending(null);
				}
			}
		},
		[confirm, refresh]
	);
	return { cancel, dialog, error, notice, pending, requested };
}

export function CancelJobButton({
	disabled = false,
	job,
	onClick,
	pending,
	requested = false,
	state,
}: {
	disabled?: boolean;
	job: QueueJob;
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
	pending: Pending;
	requested?: boolean;
	state: string | null;
}) {
	if (!canCancelJob(state)) {
		return null;
	}
	const cancelled = requested || job.cancelRequested;
	const sending = pending?.phase === "sending";
	const name = job.private ? "Анонимное задание" : job.name;
	let label = "Отменить";
	if (cancelled) {
		label = "Отмена запрошена";
	} else if (sending && pending?.id === job.id) {
		label = "Отменяю…";
	}
	return (
		<button
			aria-label={`Отменить задание: ${name}`}
			className="button button--small"
			data-job={job.id}
			data-state={state}
			disabled={disabled || cancelled || sending}
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}
