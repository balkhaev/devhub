/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: React and pointer callbacks mutate refs between renders; the analyzer incorrectly treats their initial values as constant. */
import { useCallback, useEffect, useRef, useState } from "react";

import type { KnowledgeOperation, ProjectKnowledge } from "../knowledge-schema";
import { readHub } from "./api";

export function useKnowledge(project: string) {
	const [state, setState] = useState<ProjectKnowledge | null>(null);
	const current = useRef<ProjectKnowledge | null>(null);
	const saving = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [remote, setRemote] = useState(false);
	const path = `/api/knowledge/${encodeURIComponent(project)}`;
	const install = useCallback((next: ProjectKnowledge) => {
		if (current.current && next.revision < current.current.revision) {
			return;
		}
		current.current = next;
		setState(next);
		setRemote(false);
	}, []);
	const refresh = useCallback(async () => {
		try {
			install(await readHub<ProjectKnowledge>(path));
			setError("");
		} catch (issue) {
			setError((issue as Error).message);
		}
	}, [install, path]);
	useEffect(() => {
		let active = true;
		readHub<ProjectKnowledge>(path)
			.then((next) => {
				if (active) {
					install(next);
				}
			})
			.catch((issue: Error) => {
				if (active) {
					setError(issue.message);
				}
			});
		const timer = setInterval(() => {
			if (saving.current || document.hidden) {
				return;
			}
			readHub<ProjectKnowledge>(path)
				.then((next) => {
					if (
						active &&
						!saving.current &&
						current.current &&
						next.revision > current.current.revision
					) {
						setRemote(true);
					}
				})
				.catch(() => undefined);
		}, 5000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [install, path]);
	const change = useCallback(
		async (operations: KnowledgeOperation[]): Promise<boolean> => {
			if (saving.current || !current.current) {
				return false;
			}
			saving.current = true;
			setBusy(true);
			setError("");
			try {
				const response = await fetch(path, {
					body: JSON.stringify({
						operations,
						revision: current.current.revision,
					}),
					headers: { "content-type": "application/json", "x-devhub": "1" },
					method: "POST",
				});
				const next = (await response.json()) as ProjectKnowledge & {
					error?: string;
				};
				if (!response.ok) {
					throw new Error(next.error ?? `Ошибка ${response.status}`);
				}
				install(next);
				return true;
			} catch (issue) {
				setError((issue as Error).message);
				return false;
			} finally {
				saving.current = false;
				setBusy(false);
			}
		},
		[install, path]
	);
	return { busy, change, error, refresh, remote, state };
}

export type BoardChange = (
	operations: KnowledgeOperation[]
) => Promise<boolean>;
