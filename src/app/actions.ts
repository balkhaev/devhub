import { type MouseEvent, type ReactNode, useCallback, useState } from "react";

import { act } from "./api";
import { useConfirm } from "./confirm";

/** Buttons share the same pending state, error and optional question. */
export function useAction(): {
	dialog: ReactNode;
	error: string | null;
	pending: string | null;
	run: (event: MouseEvent<HTMLButtonElement>) => Promise<void>;
} {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [confirm, dialog] = useConfirm();
	const run = useCallback(
		async (event: MouseEvent<HTMLButtonElement>) => {
			const { path, confirm: ask } = event.currentTarget.dataset;
			if (!path || (ask && !(await confirm(ask)))) {
				return;
			}
			setPending(path);
			setError(await act(path));
			setPending(null);
		},
		[confirm]
	);
	return { dialog, error, pending, run };
}
