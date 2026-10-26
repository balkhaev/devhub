import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { HubView, ProjectView, ServiceView } from "../hub";
import {
	createProjectPreferenceStore,
	ProjectPreferencesProvider,
} from "./project-preferences";
import { StartPage, StartProjectCard } from "./start-page";
import { findProjects, projectDestination } from "./start-page-model";

const noop = () => undefined;

function project(
	id: string,
	status: ServiceView["status"] = "stopped"
): ProjectView {
	return {
		currentBranch: "main",
		deletable: true,
		description: "Инструменты для изображений и видео",
		devServices: [`${id}/web`],
		docker: null,
		id,
		integrationBranch: "main",
		localOnly: false,
		mode: "mvp",
		modeEditable: true,
		name: id,
		path: `F:/code/${id}`,
		releaseBranch: "main",
		services: [
			{
				canStart: true,
				command: "bun app.ts",
				description: "Обработка файлов",
				elsewhere: null,
				exit: null,
				health: null,
				key: `${id}/web`,
				managed: false,
				name: "Генерация",
				needs: [],
				owner: null,
				pid: null,
				port: 5000,
				project: id,
				since: null,
				status,
				ui: [{ label: "Редактор", url: `http://127.0.0.1:5000/${id}` }],
				warn: null,
				workdir: `F:/code/${id}`,
			},
		],
		stageBranch: "stage",
	};
}

test("start page search combines Cyrillic project, service and page terms and preserves source order", () => {
	const alpha = project("alpha");
	const beta = project("beta");
	const gamma = project("gamma");
	beta.description = "Съёмка объектов";
	const projects = [alpha, beta, gamma];
	expect(findProjects(projects, [], " СЪЕМКА редактор ", "all")).toEqual([
		beta,
	]);
	expect(findProjects(projects, ["gamma"], "генерация", "all")).toEqual([
		gamma,
		alpha,
		beta,
	]);
	expect(projects.map((entry) => entry.id)).toEqual(["alpha", "beta", "gamma"]);
	expect(findProjects(projects, [], "неизвестный", "all")).toEqual([]);
});

test("start page filters distinguish stopped, live and attention states and combine with search", () => {
	const projects = [
		project("stopped"),
		project("running", "running"),
		project("starting", "starting"),
		project("crashed", "crashed"),
		project("busy", "busy"),
		project("unhealthy", "unhealthy"),
	];
	expect(
		findProjects(projects, ["crashed"], "", "favorites").map(
			(entry) => entry.id
		)
	).toEqual(["crashed"]);
	expect(
		findProjects(projects, [], "", "running").map((entry) => entry.id)
	).toEqual(["running", "starting", "unhealthy"]);
	expect(
		findProjects(projects, [], "", "attention").map((entry) => entry.id)
	).toEqual(["crashed", "busy", "unhealthy"]);
	expect(findProjects(projects, [], "running", "attention")).toEqual([]);
});

test("quick launch opens only a ready frontend and otherwise routes to project management", () => {
	for (const status of ["running", "external"] as const) {
		expect(projectDestination(project("sample", status))).toEqual({
			external: true,
			url: "http://127.0.0.1:5000/sample",
		});
	}
	for (const status of [
		"starting",
		"stopped",
		"unhealthy",
		"crashed",
	] as const) {
		expect(projectDestination(project("sample", status))).toEqual({
			external: false,
			url: "#/projects/sample/manage",
		});
	}
	const noFrontend = project("sample", "running");
	noFrontend.services = [];
	expect(projectDestination(noFrontend).url).toBe("#/projects/sample/manage");
	const docsOnly = project("sample", "running");
	docsOnly.services = docsOnly.services.map((service) => ({
		...service,
		ui: [{ label: "API", url: "http://127.0.0.1:5000/docs" }],
	}));
	expect(projectDestination(docsOnly).external).toBe(false);
});

test("start page reuses persisted favorites and retains management in a closed disclosure", () => {
	const store = createProjectPreferenceStore({ storage: () => undefined });
	store.toggleFavorite("beta");
	const view: HubView = {
		docker: { available: true, projects: [] },
		hub: 1,
		ports: [],
		projects: [project("alpha"), project("beta")],
		updatedAt: 1,
	};
	const markup = renderToStaticMarkup(
		<ProjectPreferencesProvider store={store}>
			<StartPage onDeleted={noop} view={view} />
		</ProjectPreferencesProvider>
	);
	expect(markup.indexOf('data-project-id="beta"')).toBeLessThan(
		markup.indexOf('data-project-id="alpha"')
	);
	expect(markup).toContain('aria-label="Убрать из избранного: beta"');
	expect(markup).toContain('<details class="start-tools">');
	expect(markup).toContain("Кто слушает порты");
	expect(markup).toContain("Запустить dev");
	expect(markup).not.toContain("autofocus");
});

test("a project tile has separate favorite, launch and management controls", () => {
	const markup = renderToStaticMarkup(
		<StartProjectCard project={project("sample", "running")} />
	);
	expect(markup).toContain('aria-label="Открыть приложение: sample"');
	expect(markup).toContain('href="http://127.0.0.1:5000/sample"');
	expect(markup).toContain('aria-label="Управление проектом: sample"');
	expect(markup).toContain('href="#/projects/sample/manage"');
	expect(markup).toContain('aria-label="В избранное: sample"');
});
