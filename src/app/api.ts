import { useCallback, useEffect, useState } from "react";

import type { HubView } from "../hub";
import type { Framing } from "../probes";

/** The page's line to the hub: its state as server-sent events, a service's log as it grows, and the actions. */

export function useHub(): { connected: boolean; view: HubView | null } {
	const [view, setView] = useState<HubView | null>(null);
	const [connected, setConnected] = useState(false);
	useEffect(() => {
		const source = new EventSource("/api/events");
		let run: number | null = null;
		source.onopen = () => setConnected(true);
		source.onerror = () => setConnected(false);
		source.onmessage = (message) => {
			const next = JSON.parse(message.data) as HubView;
			// The hub was restarted, perhaps with a new version of this page: load it.
			if (run !== null && next.hub !== run) {
				window.location.reload();
				return;
			}
			run = next.hub;
			setView(next);
		};
		return () => source.close();
	}, []);
	return { connected, view };
}

const LOG_LIMIT = 400_000;
/** Colour and cursor codes some servers print even when asked not to. */
const ESCAPES = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
	"g"
);

/** A service's log: its last part at once, then every new line as it is written. */
export function useLog(key: string | null): {
	clear: () => void;
	text: string;
} {
	const [text, setText] = useState("");
	useEffect(() => {
		setText("");
		if (!key) {
			return;
		}
		const source = new EventSource(`/api/services/${key}/log`);
		source.onmessage = (message) => {
			const data = JSON.parse(message.data) as { reset: boolean; text: string };
			const clean = data.text.replace(ESCAPES, "");
			setText((current) =>
				(data.reset ? clean : current + clean).slice(-LOG_LIMIT)
			);
		};
		return () => source.close();
	}, [key]);
	const clear = useCallback(() => setText(""), []);
	return { clear, text };
}

/** Sends an action; the hub accepts them only from its own page, marked with a header. */
export async function act(path: string): Promise<string | null> {
	try {
		const response = await fetch(path, {
			headers: { "x-devhub": "1" },
			method: "POST",
		});
		const body = (await response.json()) as {
			error?: string;
			result?: unknown;
		};
		if (!response.ok) {
			return body.error ?? `ошибка ${response.status}`;
		}
		const errors = Array.isArray(body.result) ? (body.result as string[]) : [];
		return errors.length > 0 ? errors.join("\n") : null;
	} catch (error) {
		return (error as Error).message;
	}
}

const FRAMING_MS = 30_000;
const framing = new Map<string, Promise<Framing>>();

/**
 * Whether a page can be shown inside the hub (some send X-Frame-Options). A sure answer is kept for a while; a
 * page that did not answer is asked again next time.
 */
export function checkFrame(url: string): Promise<Framing> {
	let pending = framing.get(url);
	if (!pending) {
		pending = fetch(`/api/frame?url=${encodeURIComponent(url)}`)
			.then((response) => response.json() as Promise<Framing>)
			.catch(() => ({ ok: true, reason: null, sure: false }));
		framing.set(url, pending);
		pending.then((answer) => {
			setTimeout(() => framing.delete(url), answer.sure ? FRAMING_MS : 0);
		});
	}
	return pending;
}

const ROUTE = /^#\/(.+)$/;

/** What is open (`#/project/service`, or the overview), kept in the address. */
export function useRoute(): [string | null, (key: string | null) => void] {
	const read = useCallback(
		() => ROUTE.exec(window.location.hash)?.[1] ?? null,
		[]
	);
	const [route, setRoute] = useState<string | null>(read);
	useEffect(() => {
		const onChange = () => setRoute(read());
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, [read]);
	const go = useCallback((key: string | null) => {
		window.location.hash = key ? `/${key}` : "";
	}, []);
	return [route, go];
}
