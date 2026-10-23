export type ProjectSection = "manage" | "canvas" | "kanban";

export function ProjectNav({
	id,
	section,
}: {
	id: string;
	section: ProjectSection;
}) {
	return (
		<nav aria-label="Разделы проекта" className="workspace-tabs">
			{(
				[
					["manage", "Проект"],
					["canvas", "Canvas"],
					["kanban", "Kanban"],
				] as const
			).map(([key, title]) => (
				<a
					aria-current={section === key ? "page" : undefined}
					href={`#/projects/${encodeURIComponent(id)}/${key}`}
					key={key}
				>
					{title}
				</a>
			))}
		</nav>
	);
}
