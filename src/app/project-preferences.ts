import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useSyncExternalStore,
} from "react";

// Keep the original key so saved favorites and explicit choices migrate in place.
export const PROJECT_PREFERENCES_KEY = "devhub.project-preferences.v1";
export type ProjectSurface = "overview" | "sidebar";

export interface ProjectPreferences {
	collapsed: Record<ProjectSurface, string[]>;
	expanded: Record<ProjectSurface, string[]>;
	favorites: string[];
	version: 2;
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
interface StorageChange {
	key: string | null;
	newValue: string | null;
}
interface PreferenceEnvironment {
	listen?: (receive: (event: StorageChange) => void) => () => void;
	storage?: () => PreferenceStorage | undefined;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const emptyPreferences = (): ProjectPreferences => ({
	collapsed: { overview: [], sidebar: [] },
	expanded: { overview: [], sidebar: [] },
	favorites: [],
	version: 2,
});

function ids(value: unknown): string[] {
	return Array.isArray(value)
		? [
				...new Set(
					value.filter(
						(id): id is string => typeof id === "string" && PROJECT_ID.test(id)
					)
				),
			]
		: [];
}

/** Invalid or partially malformed browser data never blocks project controls. */
export function parseProjectPreferences(
	raw: string | null
): ProjectPreferences {
	try {
		const parsed = JSON.parse(raw ?? "null") as
			| (Partial<Omit<ProjectPreferences, "version">> & { version?: number })
			| null;
		if (parsed?.version !== 1 && parsed?.version !== 2) {
			return emptyPreferences();
		}
		const collapsed = {
			overview: ids(parsed.collapsed?.overview),
			sidebar: ids(parsed.collapsed?.sidebar),
		};
		const expanded = (surface: ProjectSurface) =>
			parsed.version === 2
				? ids(parsed.expanded?.[surface]).filter(
						(id) => !collapsed[surface].includes(id)
					)
				: [];
		return {
			collapsed,
			expanded: {
				overview: expanded("overview"),
				sidebar: expanded("sidebar"),
			},
			favorites: ids(parsed.favorites),
			version: 2,
		};
	} catch {
		return emptyPreferences();
	}
}

/** Manual choices override the default: only favorites start expanded. */
export function isProjectCollapsed(
	preferences: ProjectPreferences,
	surface: ProjectSurface,
	id: string
): boolean {
	if (preferences.collapsed[surface].includes(id)) {
		return true;
	}
	return !(
		preferences.expanded[surface].includes(id) ||
		preferences.favorites.includes(id)
	);
}

/** Stable partition: preserve catalogue order within both groups and leave live data intact. */
export function favoriteProjects<T extends { id: string }>(
	projects: readonly T[],
	favorites: readonly string[]
): T[] {
	const selected = new Set(favorites);
	return [
		...projects.filter((project) => selected.has(project.id)),
		...projects.filter((project) => !selected.has(project.id)),
	];
}

function browserStorage(): PreferenceStorage | undefined {
	return typeof window === "undefined" ? undefined : window.localStorage;
}

function browserChanges(receive: (event: StorageChange) => void): () => void {
	if (typeof window === "undefined") {
		return () => undefined;
	}
	const changed = (event: StorageEvent) => {
		try {
			if (event.storageArea && event.storageArea !== window.localStorage) {
				return;
			}
		} catch {
			return;
		}
		receive(event);
	};
	window.addEventListener("storage", changed);
	return () => window.removeEventListener("storage", changed);
}

export interface ProjectPreferenceStore {
	getSnapshot: () => ProjectPreferences;
	subscribe: (listener: () => void) => () => void;
	toggleCollapse: (surface: ProjectSurface, id: string) => void;
	toggleFavorite: (id: string) => void;
}

/** One store feeds every surface. External storage updates do not write back and cause tab loops. */
export function createProjectPreferenceStore(
	environment: PreferenceEnvironment = {}
): ProjectPreferenceStore {
	const storage = environment.storage ?? browserStorage;
	const listen = environment.listen ?? browserChanges;
	const read = (): { raw: string | null } | null => {
		try {
			const available = storage();
			return available
				? { raw: available.getItem(PROJECT_PREFERENCES_KEY) }
				: null;
		} catch {
			return null;
		}
	};
	let lastStored = read()?.raw ?? null;
	let preferences = parseProjectPreferences(lastStored);
	const listeners = new Set<() => void>();
	let disconnect: (() => void) | null = null;
	const notify = () => {
		for (const listener of listeners) {
			listener();
		}
	};
	const receive = (event: StorageChange) => {
		if (event.key !== null && event.key !== PROJECT_PREFERENCES_KEY) {
			return;
		}
		lastStored = event.key === null ? null : event.newValue;
		const next = parseProjectPreferences(lastStored);
		if (JSON.stringify(next) !== JSON.stringify(preferences)) {
			preferences = next;
			notify();
		}
	};
	const update = (next: ProjectPreferences) => {
		preferences = next;
		try {
			const available = storage();
			if (available) {
				const raw = JSON.stringify(next);
				available.setItem(PROJECT_PREFERENCES_KEY, raw);
				lastStored = raw;
			}
		} catch {
			// Preferences remain usable for this tab when storage is denied or full.
		}
		notify();
	};
	const toggled = (values: string[], id: string) =>
		values.includes(id)
			? values.filter((value) => value !== id)
			: [...values, id];
	return {
		getSnapshot: () => preferences,
		subscribe: (listener) => {
			listeners.add(listener);
			if (listeners.size === 1) {
				disconnect = listen(receive);
				const stored = read();
				if (stored && stored.raw !== lastStored) {
					receive({ key: PROJECT_PREFERENCES_KEY, newValue: stored.raw });
				}
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					disconnect?.();
					disconnect = null;
				}
			};
		},
		toggleCollapse: (surface, id) => {
			const collapsed = isProjectCollapsed(preferences, surface, id);
			update({
				...preferences,
				collapsed: {
					...preferences.collapsed,
					[surface]: collapsed
						? preferences.collapsed[surface].filter((value) => value !== id)
						: [...preferences.collapsed[surface], id],
				},
				expanded: {
					...preferences.expanded,
					[surface]: collapsed
						? [...preferences.expanded[surface], id]
						: preferences.expanded[surface].filter((value) => value !== id),
				},
			});
		},
		toggleFavorite: (id) => {
			const withoutProject = (values: Record<ProjectSurface, string[]>) => ({
				overview: values.overview.filter((value) => value !== id),
				sidebar: values.sidebar.filter((value) => value !== id),
			});
			update({
				...preferences,
				collapsed: withoutProject(preferences.collapsed),
				expanded: withoutProject(preferences.expanded),
				favorites: toggled(preferences.favorites, id),
			});
		},
	};
}

const browserPreferences = createProjectPreferenceStore();
const PreferencesContext = createContext(browserPreferences);

export function ProjectPreferencesProvider({
	children,
	store = browserPreferences,
}: {
	children: ReactNode;
	store?: ProjectPreferenceStore;
}) {
	return createElement(PreferencesContext.Provider, { value: store }, children);
}

export function useProjectPreferences() {
	const store = useContext(PreferencesContext);
	const preferences = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot
	);
	return {
		preferences,
		toggleCollapse: store.toggleCollapse,
		toggleFavorite: store.toggleFavorite,
	};
}
