import type { ProjectView } from "../hub";
import { favoriteProjects } from "./project-preferences";
import { mainFrontend, projectRoute } from "./project-ui";
import { isLive } from "./words";

export type ProjectFilter = "all" | "favorites" | "running" | "attention";

const SEARCH_WORDS = /\s+/;
const NAME_WORDS = /[\s/_-]+/;

export function projectHasAttention(project: ProjectView): boolean {
	return project.services.some((service) =>
		["crashed", "unhealthy", "busy"].includes(service.status)
	);
}

export function projectIsRunning(project: ProjectView): boolean {
	return project.services.some((service) => isLive(service.status));
}

function searchable(value: string): string {
	return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

/** Search the declared catalogue, including service and page names, without changing its order. */
export function findProjects(
	projects: ProjectView[],
	favorites: string[],
	query: string,
	filter: ProjectFilter
): ProjectView[] {
	const terms = searchable(query).trim().split(SEARCH_WORDS).filter(Boolean);
	return favoriteProjects(projects, favorites).filter((project) => {
		if (
			(filter === "favorites" && !favorites.includes(project.id)) ||
			(filter === "running" && !projectIsRunning(project)) ||
			(filter === "attention" && !projectHasAttention(project))
		) {
			return false;
		}
		const text = searchable(
			[
				project.name,
				project.id,
				project.description,
				...project.services.flatMap((service) => [
					service.name,
					service.description,
					...service.ui.map((page) => page.label),
				]),
			].join(" ")
		);
		return terms.every((term) => text.includes(term));
	});
}

/** A stopped, starting or unhealthy app opens management instead of a broken frontend. */
export function projectDestination(project: ProjectView): {
	external: boolean;
	url: string;
} {
	const frontend = mainFrontend(project);
	return frontend &&
		(frontend.service.status === "running" ||
			frontend.service.status === "external")
		? { external: true, url: frontend.url }
		: { external: false, url: `#/${projectRoute(project.id)}` };
}

export function projectIdentity(project: ProjectView): {
	initials: string;
	tone: number;
} {
	const words = project.name.trim().split(NAME_WORDS);
	const initials =
		words.length > 1
			? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
			: project.name.slice(0, 2);
	let hash = 0;
	for (const letter of project.id) {
		hash = (hash * 31 + letter.charCodeAt(0)) % 65_521;
	}
	return { initials: initials.toLocaleUpperCase("ru-RU"), tone: hash % 7 };
}
