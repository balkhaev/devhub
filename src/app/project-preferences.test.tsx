import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HubView, ProjectView, ServiceView } from "../hub";
import { Overview } from "./overview";
import { ProjectPage } from "./project";
import {
	createProjectPreferenceStore,
	favoriteProjects,
	PROJECT_PREFERENCES_KEY,
	type ProjectPreferenceStore,
	ProjectPreferencesProvider,
	parseProjectPreferences,
} from "./project-preferences";
import { Sidebar } from "./sidebar";

const noop = () => undefined;
const ARTICLE = /<article\b[\s\S]*?<\/article>/;
interface Signal {
	key: string | null;
	newValue: string | null;
}

function memoryPreferences(raw: string | null = null) {
	const data = { raw, writes: 0 };
	const listeners = new Set<(signal: Signal) => void>();
	const storage = {
		getItem: () => data.raw,
		setItem: (_key: string, value: string) => {
			data.raw = value;
			data.writes += 1;
		},
	};
	return {
		data,
		emit: (signal: Signal) => {
			if (signal.key === PROJECT_PREFERENCES_KEY || signal.key === null) {
				data.raw = signal.newValue;
			}
			for (const listener of listeners) {
				listener(signal);
			}
		},
		environment: {
			listen: (receive: (signal: Signal) => void) => {
				listeners.add(receive);
				return () => {
					listeners.delete(receive);
				};
			},
			storage: () => storage,
		},
		listeners,
	};
}

function service(
	projectId: string,
	status: ServiceView["status"] = "stopped"
): ServiceView {
	return {
		canStart: true,
		command: "bun app.ts",
		description: null,
		elsewhere: null,
		exit: null,
		health: null,
		key: `${projectId}/web`,
		managed: false,
		name: "Web service",
		needs: [],
		owner: null,
		pid: null,
		port: 5000,
		project: projectId,
		since: null,
		status,
		ui: [{ label: "Приложение", url: `http://127.0.0.1:5000/${projectId}` }],
		warn: null,
		workdir: `D:/code/${projectId}`,
	};
}

function project(id: string, status?: ServiceView["status"]): ProjectView {
	return {
		currentBranch: "stage",
		deletable: true,
		description: `Detailed description ${id}`,
		devServices: [`${id}/web`],
		docker: null,
		id,
		name: id,
		path: `D:/code/${id}`,
		services: [service(id, status)],
		stageBranch: "stage",
	};
}

function view(projects: ProjectView[]): HubView {
	return {
		docker: { available: false, projects: [] },
		hub: 1,
		ports: [],
		projects,
		updatedAt: 1,
	};
}

function render(store: ProjectPreferenceStore, children: ReactNode): string {
	return renderToStaticMarkup(
		<ProjectPreferencesProvider store={store}>
			{children}
		</ProjectPreferencesProvider>
	);
}

test("malformed preferences fall back safely while valid sets keep unknown projects and remove duplicates", () => {
	for (const raw of [
		null,
		"broken JSON",
		"null",
		"[]",
		'{"version":2}',
		'{"favorites":["sample"]}',
	]) {
		expect(parseProjectPreferences(raw)).toEqual({
			collapsed: { overview: [], sidebar: [] },
			favorites: [],
			version: 1,
		});
	}
	const parsed = parseProjectPreferences(
		JSON.stringify({
			collapsed: { overview: ["sample", "sample", false], sidebar: "sample" },
			favorites: ["future-project", "future-project", 4, "", "../folder"],
			version: 1,
		})
	);
	expect(parsed).toEqual({
		collapsed: { overview: ["sample"], sidebar: [] },
		favorites: ["future-project"],
		version: 1,
	});
});

test("favorite-first ordering is stable, ignores missing IDs and never mutates the catalogue", () => {
	const projects = Object.freeze([
		Object.freeze({ id: "alpha" }),
		Object.freeze({ id: "beta" }),
		Object.freeze({ id: "gamma" }),
		Object.freeze({ id: "delta" }),
	]);
	const ordered = favoriteProjects(projects, ["delta", "missing", "beta"]);
	expect(ordered.map((item) => item.id)).toEqual([
		"beta",
		"delta",
		"alpha",
		"gamma",
	]);
	expect(projects.map((item) => item.id)).toEqual([
		"alpha",
		"beta",
		"gamma",
		"delta",
	]);
	expect(favoriteProjects(projects, [])).toEqual([...projects]);
});

test("both surfaces share favorites while independent collapse preferences survive reopening", () => {
	const memory = memoryPreferences();
	const store = createProjectPreferenceStore(memory.environment);
	let overviewChanges = 0;
	let sidebarChanges = 0;
	const offOverview = store.subscribe(() => {
		overviewChanges += 1;
	});
	const offSidebar = store.subscribe(() => {
		sidebarChanges += 1;
	});
	store.toggleFavorite("beta");
	store.toggleCollapse("overview", "alpha");
	expect(store.getSnapshot().favorites).toEqual(["beta"]);
	expect(store.getSnapshot().collapsed).toEqual({
		overview: ["alpha"],
		sidebar: [],
	});
	expect(overviewChanges).toBe(2);
	expect(sidebarChanges).toBe(2);
	store.toggleCollapse("sidebar", "beta");
	const reopened = createProjectPreferenceStore(memory.environment);
	expect(reopened.getSnapshot()).toEqual(store.getSnapshot());
	store.toggleFavorite("beta");
	store.toggleCollapse("overview", "alpha");
	expect(store.getSnapshot()).toEqual({
		collapsed: { overview: [], sidebar: ["beta"] },
		favorites: [],
		version: 1,
	});
	offOverview();
	offSidebar();
	expect(memory.listeners.size).toBe(0);
});

test("denied reads and quota failures retain responsive tab preferences without throwing", () => {
	const denied = createProjectPreferenceStore({
		storage: () => {
			throw new Error("Access denied");
		},
	});
	expect(() => {
		denied.toggleFavorite("alpha");
		denied.toggleCollapse("sidebar", "alpha");
	}).not.toThrow();
	expect(denied.getSnapshot().favorites).toEqual(["alpha"]);
	expect(denied.getSnapshot().collapsed.sidebar).toEqual(["alpha"]);
	const quota = createProjectPreferenceStore({
		storage: () => ({
			getItem: () => null,
			setItem: () => {
				throw new Error("Quota exceeded");
			},
		}),
	});
	expect(() => quota.toggleFavorite("beta")).not.toThrow();
	const off = quota.subscribe(noop);
	expect(quota.getSnapshot().favorites).toEqual(["beta"]);
	off();
});

test("other tabs synchronize all preferences without echo writes; remove and clear reset the view", () => {
	const memory = memoryPreferences();
	const store = createProjectPreferenceStore(memory.environment);
	const off = store.subscribe(noop);
	const external = JSON.stringify({
		collapsed: { overview: ["alpha"], sidebar: ["beta"] },
		favorites: ["gamma"],
		version: 1,
	});
	memory.emit({ key: "unrelated", newValue: external });
	expect(store.getSnapshot().favorites).toEqual([]);
	memory.emit({ key: PROJECT_PREFERENCES_KEY, newValue: external });
	expect(store.getSnapshot()).toEqual(JSON.parse(external));
	expect(memory.data.writes).toBe(0);
	memory.emit({ key: PROJECT_PREFERENCES_KEY, newValue: null });
	expect(store.getSnapshot().collapsed).toEqual({ overview: [], sidebar: [] });
	store.toggleFavorite("alpha");
	memory.emit({ key: null, newValue: null });
	expect(store.getSnapshot().favorites).toEqual([]);
	expect(memory.data.writes).toBe(1);
	off();
	memory.emit({ key: PROJECT_PREFERENCES_KEY, newValue: external });
	const reconnected = store.subscribe(noop);
	expect(store.getSnapshot().favorites).toEqual(["gamma"]);
	reconnected();
});

test("favorites render first in overview and sidebar and are manageable on the project page", () => {
	const store = createProjectPreferenceStore({ storage: () => undefined });
	const data = view([project("alpha"), project("beta"), project("gamma")]);
	store.toggleFavorite("gamma");
	const overview = render(store, <Overview onDeleted={noop} view={data} />);
	const sidebar = render(
		store,
		<Sidebar onOpen={noop} selected={null} view={data} />
	);
	expect(overview.indexOf('href="#/projects/gamma/manage"')).toBeLessThan(
		overview.indexOf('href="#/projects/alpha/manage"')
	);
	expect(sidebar.indexOf('data-key="projects/gamma/manage"')).toBeLessThan(
		sidebar.indexOf('data-key="projects/alpha/manage"')
	);
	for (const markup of [
		overview,
		sidebar,
		render(store, <ProjectPage onDeleted={noop} project={project("gamma")} />),
	]) {
		expect(markup).toContain(
			'aria-label="Убрать из избранного: gamma" aria-pressed="true"'
		);
	}
	store.toggleFavorite("gamma");
	const restored = render(store, <Overview onDeleted={noop} view={data} />);
	expect(restored.indexOf('href="#/projects/alpha/manage"')).toBeLessThan(
		restored.indexOf('href="#/projects/gamma/manage"')
	);
});

test("collapsed cards keep navigation, state and frontend while hiding details independently of the sidebar", () => {
	const store = createProjectPreferenceStore({ storage: () => undefined });
	const data = view([project("alpha", "crashed")]);
	store.toggleCollapse("overview", "alpha");
	const card =
		render(store, <Overview onDeleted={noop} view={data} />).match(
			ARTICLE
		)?.[0] ?? "";
	expect(card).toContain('href="#/projects/alpha/manage"');
	expect(card).toContain("Работают 0 из 1 · требуют внимания: 1");
	expect(card).toContain('href="http://127.0.0.1:5000/alpha"');
	expect(card).toContain(
		'aria-controls="overview-project-alpha" aria-expanded="false"'
	);
	expect(card).toContain('hidden="" id="overview-project-alpha"');
	expect(card).not.toContain("Detailed description");
	// Keep stateful controls mounted in the hidden region so a pending request survives collapse.
	for (const hidden of [
		"D:/code/alpha",
		"Запустить dev",
		"Удалить проект…",
		'href="#/alpha/web"',
	]) {
		expect(card.indexOf(hidden)).toBeGreaterThan(
			card.indexOf('hidden="" id="overview-project-alpha"')
		);
	}
	expect(card.indexOf('href="http://127.0.0.1:5000/alpha"')).toBeLessThan(
		card.indexOf('hidden="" id="overview-project-alpha"')
	);
	const sidebar = render(
		store,
		<Sidebar onOpen={noop} selected="alpha/web" view={data} />
	);
	expect(sidebar).toContain(
		'aria-controls="sidebar-project-alpha" aria-expanded="true"'
	);
	expect(sidebar).toContain('data-key="alpha/web"');
	store.toggleCollapse("sidebar", "alpha");
	const compact = render(
		store,
		<Sidebar onOpen={noop} selected="alpha/web" view={data} />
	);
	expect(compact).toContain(
		'aria-controls="sidebar-project-alpha" aria-expanded="false"'
	);
	expect(compact).toContain('class="side-project side-project--selected"');
	expect(compact).toContain("Открыт: Web service");
	expect(compact).toContain('aria-label="Открыть приложение: alpha"');
	expect(compact).not.toContain('data-key="alpha/web"');
	store.toggleCollapse("overview", "alpha");
	expect(render(store, <Overview onDeleted={noop} view={data} />)).toContain(
		"D:/code/alpha"
	);
});

test("collapsed projects without services retain their name and controls without an invented frontend", () => {
	const store = createProjectPreferenceStore({ storage: () => undefined });
	const empty = { ...project("empty"), devServices: [], services: [] };
	store.toggleCollapse("overview", "empty");
	const card =
		render(store, <Overview onDeleted={noop} view={view([empty])} />).match(
			ARTICLE
		)?.[0] ?? "";
	expect(card).toContain("Нет dev-сервисов");
	expect(card).toContain('aria-label="В избранное: empty"');
	expect(card).toContain('aria-label="Развернуть проект: empty"');
	expect(card).not.toContain("Открыть приложение");
});
