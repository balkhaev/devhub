import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { DialogPortal } from "./dialog-portal";

/**
 * Asking before an action that stops something or spends something: a dialog of the page's own, in its colours,
 * that answers a promise. Escape and «Отмена» say no.
 */

function Question({
	onAnswer,
	text,
}: {
	onAnswer: (yes: boolean) => void;
	text: string;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const yes = useCallback(() => onAnswer(true), [onAnswer]);
	const no = useCallback(() => onAnswer(false), [onAnswer]);
	return (
		<DialogPortal>
			<dialog
				aria-label="Подтверждение"
				className="confirm"
				onCancel={no}
				ref={dialog}
			>
				<p className="confirm__text">{text}</p>
				<div className="confirm__actions">
					<button className="button" onClick={no} type="button">
						Отмена
					</button>
					<button
						className="button button--primary"
						onClick={yes}
						type="button"
					>
						Да
					</button>
				</div>
			</dialog>
		</DialogPortal>
	);
}

/** A function that asks and resolves to the answer, and the dialog to render while it asks. */
export function useConfirm(): [(text: string) => Promise<boolean>, ReactNode] {
	const [asking, setAsking] = useState<{
		answer: (yes: boolean) => void;
		text: string;
	} | null>(null);
	const confirm = useCallback(
		(text: string) =>
			new Promise<boolean>((resolve) => {
				setAsking({ answer: resolve, text });
			}),
		[]
	);
	const answer = useCallback(
		(yes: boolean) => {
			asking?.answer(yes);
			setAsking(null);
		},
		[asking]
	);
	const dialog = asking ? (
		<Question onAnswer={answer} text={asking.text} />
	) : null;
	return [confirm, dialog];
}
