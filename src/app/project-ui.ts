import type { ProjectView, ServiceView } from "../hub";

const DOCUMENTATION = /^(?:api(?:\b|\/)|swagger|openapi|redoc|документация)/i;
const DOCUMENTATION_PATH =
	/^\/(?:api(?:\/|$)|(?:[^/]+\/)?(?:docs|redoc|swagger)(?:\/|$)|openapi\.json$)/i;

export const projectRoute = (id: string): string =>
	`projects/${encodeURIComponent(id)}/manage`;

function isFrontend(entry: { label: string; url: string }): boolean {
	if (DOCUMENTATION.test(entry.label)) {
		return false;
	}
	try {
		return !DOCUMENTATION_PATH.test(new URL(entry.url).pathname);
	} catch {
		return false;
	}
}

/** Respect the default dev entrypoint and the project's declared page order. */
export function mainFrontend(project: ProjectView): {
	label: string;
	service: ServiceView;
	url: string;
} | null {
	const defaults = new Set(project.devServices);
	const services = [
		...project.services.filter((service) => defaults.has(service.key)),
		...project.services.filter((service) => !defaults.has(service.key)),
	];
	for (const service of services) {
		const page = service.ui.find(isFrontend);
		if (page) {
			return { ...page, service };
		}
	}
	return null;
}
