import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProjectView, ServiceView } from "../hub";
import {
	RunningProjectsList,
	RunningProjectsMenu,
	restartQuestion,
	stopQuestion,
} from "./running-projects";

function service(id: string, changes: Partial<ServiceView> = {}): ServiceView {
	return {
		canStart: true,
		command: "bun app.ts",
		description: null,
		elsewhere: null,
		exit: null,
		health: null,
		key: `sample/${id}`,
		managed: false,
		name: id,
		needs: [],
		owner: null,
		pid: null,
		port: 5000,
		project: "sample",
		since: null,
		status: "stopped",
		ui: [{ label: "Приложение", url: "http://127.0.0.1:5000/" }],
		warn: null,
		workdir: "F:/code/sample",
		...changes,
	};
}

function project(changes: Partial<ProjectView> = {}): ProjectView {
	return {
		currentBranch: "stage",
		deletable: true,
		description: null,
		devServices: ["sample/web"],
		docker: null,
		id: "sample",
		integrationBranch: "stage",
		localOnly: false,
		mode: "prod",
		modeEditable: true,
		name: "Sample",
		path: "F:/code/sample",
		releaseBranch: "main",
		services: [service("web")],
		stageBranch: "stage",
		...changes,
	};
}

test("a running project can be opened, restarted and stopped", () => {
	const markup = renderToStaticMarkup(
		<RunningProjectsList
			projects={[
				project({
					services: [service("web", { managed: true, status: "running" })],
				}),
			]}
		/>
	);
	expect(markup).toContain("Sample");
	expect(markup).toContain('href="http://127.0.0.1:5000/"');
	expect(markup).toContain(">Открыть<");
	expect(markup).toContain('data-path="/api/projects/sample/restart"');
	expect(markup).toContain(">Перезапустить<");
	expect(markup).toContain(">Остановить<");
	expect(markup).toContain('href="#/sample/web"');
});

test("a down frontend opens the project page, and a stopped project is left out", () => {
	const markup = renderToStaticMarkup(
		<RunningProjectsList
			projects={[
				project({
					services: [
						service("web"),
						service("api", {
							key: "sample/api",
							managed: true,
							port: 5001,
							status: "unhealthy",
							ui: [],
						}),
					],
				}),
				project({ id: "idle", name: "Idle" }),
			]}
		/>
	);
	expect(markup).toContain("Sample");
	expect(markup).not.toContain("Idle");
	expect(markup).toContain('href="#/projects/sample/manage"');
	expect(markup).not.toContain('href="http://127.0.0.1:5000/"');
	expect(markup).toContain("api:5001 · не отвечает");
});

test("nothing running is said plainly", () => {
	const markup = renderToStaticMarkup(
		<RunningProjectsList projects={[project()]} />
	);
	expect(markup).toContain("Ничего не запущено.");
	expect(markup).not.toContain("Остановить");
});

test("stopping or restarting a foreign process is asked about first", () => {
	const foreign = service("web", {
		owner: {
			checkout: "F:/code/sample",
			command: "bun app.ts",
			docker: null,
			label: "bun.exe (PID 10) из F:/code/sample",
			name: "bun.exe",
			pid: 10,
		},
		status: "external",
	});
	const running = project({ services: [foreign] });
	expect(stopQuestion(running, [foreign])).toContain(
		"bun.exe (PID 10) из F:/code/sample"
	);
	expect(stopQuestion(running, [foreign])).toContain("Остановить Sample");
	expect(restartQuestion(running, [foreign])).toContain(
		"Перезапустить Sample?"
	);
	expect(
		stopQuestion(running, [
			service("web", { managed: true, status: "running" }),
		])
	).toBeNull();
});

test("the header names how many projects are running and keeps the list closed", () => {
	const markup = renderToStaticMarkup(
		<RunningProjectsMenu
			projects={[
				project({
					services: [service("web", { managed: true, status: "running" })],
				}),
				project({
					id: "other",
					name: "Other",
					services: [
						service("web", {
							key: "other/web",
							project: "other",
							status: "external",
						}),
					],
				}),
				project({ id: "idle", name: "Idle" }),
			]}
		/>
	);
	expect(markup).toContain("Запущено 2 проекта");
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).not.toContain(">Остановить<");
});

test("the header says when every project is stopped", () => {
	const markup = renderToStaticMarkup(
		<RunningProjectsMenu projects={[project()]} />
	);
	expect(markup).toContain("Ничего не запущено");
});
