import { mainFrontend, projectRoute } from "./app/project-ui";
import { isLive, STATUS_SHORT } from "./app/words";
import type { ProjectView, ServiceStatus, ServiceView } from "./hub";

/** A running project as the tray window draws it: one compact card. */

const TONE_ORDER: ServiceStatus[] = [
	"unhealthy",
	"starting",
	"external",
	"running",
];

export interface RunningCard {
	foreign: boolean;
	id: string;
	name: string;
	/** The app, when its page is up. Otherwise the tray opens `page`. */
	open: string | null;
	page: string;
	restart: boolean;
	summary: string;
	tone: ServiceStatus;
}

function liveServices(project: ProjectView): ServiceView[] {
	return project.services.filter((service) => isLive(service.status));
}

function toneOf(services: ServiceView[]): ServiceStatus {
	for (const status of TONE_ORDER) {
		if (services.some((service) => service.status === status)) {
			return status;
		}
	}
	return "running";
}

function serviceLabel(service: ServiceView): string {
	const port = service.port ? `:${service.port}` : "";
	const state =
		service.status === "running" || service.status === "external"
			? ""
			: ` · ${STATUS_SHORT[service.status]}`;
	return `${service.name}${port}${state}`;
}

export function runningCards(projects: ProjectView[]): RunningCard[] {
	const cards: RunningCard[] = [];
	for (const project of projects) {
		const services = liveServices(project);
		if (services.length === 0) {
			continue;
		}
		const frontend = mainFrontend(project);
		const open =
			frontend &&
			services.some((service) => service.key === frontend.service.key)
				? frontend.url
				: null;
		cards.push({
			foreign: services.some((service) => !service.managed),
			id: project.id,
			name: project.name,
			open,
			page: `#/${projectRoute(project.id)}`,
			restart: services.some((service) => service.canStart),
			summary: services.map(serviceLabel).join(" · "),
			tone: toneOf(services),
		});
	}
	return cards;
}
