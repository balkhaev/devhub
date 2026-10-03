import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep an active modal visible when another tab collapses its project's details. */
export function DialogPortal({ children }: { children: ReactNode }) {
	return typeof document === "undefined"
		? children
		: createPortal(children, document.body);
}
