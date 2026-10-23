const CONFIG = JSON.stringify(
	{
		mcpServers: {
			devhub: { args: ["F:/code/devhub/src/mcp.ts"], command: "bun" },
		},
	},
	null,
	2
);

export function McpSettings() {
	return (
		<section className="mcp-settings card">
			<p className="eyebrow">База знаний</p>
			<h2>Подключение агентов по MCP</h2>
			<p className="muted">
				Подключите DevHub в MCP-клиенте агента. Он получит доступ к canvas и
				kanban всех проектов: сможет сохранять решения, строить схемы и вести
				задачи. Изменения появятся на тех же досках в пульте.
			</p>
			<h3>Команда запуска</h3>
			<pre>
				<code>bun F:/code/devhub/src/mcp.ts</code>
			</pre>
			<h3>Конфигурация MCP</h3>
			<p className="muted small">
				Добавьте этот сервер в конфигурацию клиента и переподключите его. Сервер
				использует stdio; открывать сетевой порт не требуется.
			</p>
			<pre>
				<code>{CONFIG}</code>
			</pre>
			<h3>Инструменты агента</h3>
			<dl className="mcp-tools">
				<dt>
					<code>projects_list</code>
				</dt>
				<dd>Найти проект и его идентификатор.</dd>
				<dt>
					<code>knowledge_read</code>
				</dt>
				<dd>Прочитать блоки, связи, колонки и карточки.</dd>
				<dt>
					<code>knowledge_search</code>
				</dt>
				<dd>Найти решения, заметки и задачи по тексту.</dd>
				<dt>
					<code>knowledge_apply</code>
				</dt>
				<dd>Создать, изменить, переместить или удалить элементы досок.</dd>
			</dl>
			<p className="muted small">
				Перед записью агент читает текущую ревизию. Если доску уже изменили, он
				должен перечитать её и согласовать правки.
			</p>
		</section>
	);
}
