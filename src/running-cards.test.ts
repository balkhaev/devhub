import { expect, test } from "bun:test";

import type { ProjectView, ServiceView } from "./hub";
import { runningCards } from "./running-cards";

function service(id: string, changes: Partial<ServiceView> = {}): ServiceView {
	return {
		canStart: true,
		command: "bun app.ts",
		description: null,
		elsewhere: null,
		exit: null,
		health: null,
		key: `sample/${id}`,
		managed: true,
		name: id,
		needs: [],
		owner: null,
		pid: 1,
		port: 5000,
		project: "sample",
		since: null,
		status: "running",
		ui: [{ label: "Приложение", url: "http://127.0.0.1:5000/" }],
		warn: null,
		workdir: "F:/code/sample",
		...changes,
	};
}

function project(changes: Partial<ProjectView> = {}): ProjectView {
	return {
		currentBranch: null,
		deletable: false,
		description: null,
		devServices: ["sample/web"],
		docker: null,
		id: "sample",
		integrationBranch: null,
		localOnly: false,
		mode: null,
		modeEditable: false,
		name: "Sample",
		path: "F:/code/sample",
		releaseBranch: null,
		services: [service("web")],
		stageBranch: null,
		...changes,
	};
}

test("running cards keep the app address and skip a stopped project", () => {
	const cards = runningCards([
		project(),
		project({
			id: "idle",
			name: "Idle",
			services: [service("web", { status: "stopped" })],
		}),
		project({
			devServices: [],
			id: "api-only",
			name: "Api",
			services: [
				service("api", {
					key: "api-only/api",
					managed: false,
					port: 5001,
					project: "api-only",
					status: "external",
					ui: [],
				}),
			],
		}),
	]);
	expect(cards.map((card) => card.id)).toEqual(["sample", "api-only"]);
	expect(cards[0]).toMatchObject({
		foreign: false,
		open: "http://127.0.0.1:5000/",
		page: "#/projects/sample/manage",
		restart: true,
		summary: "web:5000",
		tone: "running",
	});
	expect(cards[1]).toMatchObject({
		foreign: true,
		open: null,
		restart: true,
		summary: "api:5001",
		tone: "external",
	});
});
