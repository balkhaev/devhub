import type { ProjectView } from "../hub";
import { McpSettings } from "./mcp-settings";
import { ProdPage } from "./prod";
import { TidyPage } from "./tidy";

export function SettingsPage({
	projects,
	section,
}: {
	projects: ProjectView[];
	section: string;
}) {
	const prod = section === "prod";
	let content = <TidyPage projects={projects} />;
	if (prod) {
		content = <ProdPage projects={projects} />;
	}
	if (section === "mcp") {
		content = <McpSettings />;
	}
	return (
		<section className="settings-page">
			<header className="workspace-heading">
				<div>
					<p className="eyebrow">Пульт</p>
					<h1>Настройки</h1>
					<p className="muted">Порядок на компьютере и окружения проектов.</p>
				</div>
			</header>
			<nav aria-label="Разделы настроек" className="workspace-tabs">
				<a
					aria-current={section === "tidy" ? "page" : undefined}
					href="#/settings/tidy"
				>
					Порядок
				</a>
				<a aria-current={prod ? "page" : undefined} href="#/settings/prod">
					Прод
				</a>
				<a
					aria-current={section === "mcp" ? "page" : undefined}
					href="#/settings/mcp"
				>
					Агенты / MCP
				</a>
			</nav>
			{content}
		</section>
	);
}
