import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
	emptyKnowledge,
	type KnowledgeOperation,
	knowledgeChangeSchema,
	type ProjectKnowledge,
} from "./knowledge-schema";

export class KnowledgeError extends Error {
	readonly status: number;
	constructor(message: string, status = 400, options?: ErrorOptions) {
		super(message, options);
		this.status = status;
	}
}

function put<T extends { id: string }>(items: T[], item: T): void {
	const index = items.findIndex((entry) => entry.id === item.id);
	if (index < 0) {
		items.push(item);
	} else {
		items[index] = item;
	}
}

function apply(state: ProjectKnowledge, operation: KnowledgeOperation): void {
	const { canvas, kanban } = state;
	switch (operation.type) {
		case "canvas.node.put":
			put(canvas.nodes, operation.node);
			break;
		case "canvas.node.delete":
			canvas.nodes = canvas.nodes.filter((node) => node.id !== operation.id);
			canvas.edges = canvas.edges.filter(
				(edge) => edge.from !== operation.id && edge.to !== operation.id
			);
			break;
		case "canvas.edge.put":
			put(canvas.edges, operation.edge);
			break;
		case "canvas.edge.delete":
			canvas.edges = canvas.edges.filter((edge) => edge.id !== operation.id);
			break;
		case "kanban.column.put":
			put(kanban.columns, operation.column);
			break;
		case "kanban.column.delete":
			if (kanban.cards.some((card) => card.columnId === operation.id)) {
				throw new KnowledgeError("Сначала перенесите карточки из колонки");
			}
			if (kanban.columns.length === 1) {
				throw new KnowledgeError(
					"На доске должна остаться хотя бы одна колонка"
				);
			}
			kanban.columns = kanban.columns.filter(
				(column) => column.id !== operation.id
			);
			break;
		case "kanban.card.put": {
			put(kanban.cards, operation.card);
			if (operation.beforeId) {
				const before = kanban.cards.find(
					(card) => card.id === operation.beforeId
				);
				if (
					!before ||
					before.id === operation.card.id ||
					before.columnId !== operation.card.columnId
				) {
					throw new KnowledgeError(
						"beforeId должен указывать другую карточку той же колонки"
					);
				}
				kanban.cards = kanban.cards.filter(
					(card) => card.id !== operation.card.id
				);
				kanban.cards.splice(
					kanban.cards.findIndex((card) => card.id === before.id),
					0,
					operation.card
				);
			}
			break;
		}
		case "kanban.card.delete":
			kanban.cards = kanban.cards.filter((card) => card.id !== operation.id);
			break;
		case "kanban.card.move": {
			const card = kanban.cards.find((entry) => entry.id === operation.id);
			if (!card) {
				throw new KnowledgeError("Карточка больше не существует");
			}
			kanban.cards = kanban.cards.filter((entry) => entry.id !== card.id);
			const before = operation.beforeId
				? kanban.cards.find(
						(entry) =>
							entry.id === operation.beforeId &&
							entry.columnId === operation.columnId
					)
				: null;
			if (operation.beforeId && !before) {
				throw new KnowledgeError(
					"beforeId должен указывать другую карточку той же колонки"
				);
			}
			kanban.cards.splice(
				before ? kanban.cards.indexOf(before) : kanban.cards.length,
				0,
				{ ...card, columnId: operation.columnId }
			);
			break;
		}
		default:
			break;
	}
}

function validate(state: ProjectKnowledge): void {
	if (
		state.canvas.nodes.length > 1000 ||
		state.canvas.edges.length > 2000 ||
		state.kanban.cards.length > 2000 ||
		state.kanban.columns.length > 30
	) {
		throw new KnowledgeError("Достигнут лимит элементов доски");
	}
	const nodes = new Set(state.canvas.nodes.map((node) => node.id));
	for (const edge of state.canvas.edges) {
		if (
			!(nodes.has(edge.from) && nodes.has(edge.to)) ||
			edge.from === edge.to
		) {
			throw new KnowledgeError(
				"Связь должна соединять два существующих разных блока"
			);
		}
	}
	const columns = new Set(state.kanban.columns.map((column) => column.id));
	if (state.kanban.cards.some((card) => !columns.has(card.columnId))) {
		throw new KnowledgeError(
			"Карточка должна принадлежать существующей колонке"
		);
	}
	if (JSON.stringify(state).length > 4_000_000) {
		throw new KnowledgeError("База знаний проекта превышает 4 МБ");
	}
}

/** One writer (the hub), atomic batches, and revisions shared by the browser and every MCP client. */
export class KnowledgeStore {
	private database?: Database;
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}

	private db(): Database {
		if (!this.database) {
			if (this.file !== ":memory:") {
				mkdirSync(resolve(dirname(this.file)), { recursive: true });
			}
			this.database = new Database(this.file, { create: true, strict: true });
			this.database.exec(
				"PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS knowledge (project TEXT PRIMARY KEY, body TEXT NOT NULL)"
			);
		}
		return this.database;
	}

	read(projectPath: string): ProjectKnowledge {
		const row = this.db()
			.query<{ body: string }, [string]>(
				"SELECT body FROM knowledge WHERE project = ?"
			)
			.get(resolve(projectPath).replaceAll("\\", "/").toLowerCase());
		return row ? (JSON.parse(row.body) as ProjectKnowledge) : emptyKnowledge();
	}

	change(projectPath: string, input: unknown): ProjectKnowledge {
		const parsed = knowledgeChangeSchema.safeParse(input);
		if (!parsed.success) {
			throw new KnowledgeError(parsed.error.message);
		}
		return this.db()
			.transaction(() => {
				const state = this.read(projectPath);
				if (parsed.data.revision !== state.revision) {
					throw new KnowledgeError(
						"Доска изменилась. Обновите её и повторите правку; ваш текст сохранён в редакторе.",
						409
					);
				}
				for (const operation of parsed.data.operations) {
					apply(state, operation);
				}
				validate(state);
				state.revision += 1;
				state.updatedAt = new Date().toISOString();
				this.db()
					.query(
						"INSERT INTO knowledge (project, body) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET body = excluded.body"
					)
					.run(
						resolve(projectPath).replaceAll("\\", "/").toLowerCase(),
						JSON.stringify(state)
					);
				return state;
			})
			.immediate();
	}

	close(): void {
		this.database?.close();
		this.database = undefined;
	}
}

export function searchKnowledge(state: ProjectKnowledge, query: string) {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle || needle.length > 300) {
		throw new KnowledgeError("Нужен поисковый запрос от 1 до 300 символов");
	}
	return [
		...state.canvas.nodes.map((node) => ({
			id: node.id,
			kind: "canvas",
			text: node.text,
			title: node.title,
		})),
		...state.canvas.edges.map((edge) => ({
			id: edge.id,
			kind: "connection",
			text: `${edge.from} → ${edge.to}`,
			title: edge.label,
		})),
		...state.kanban.cards.map((card) => ({
			id: card.id,
			kind: "kanban",
			text: `${card.text}\n${card.labels.join(" ")}`,
			title: card.title,
		})),
	]
		.filter((entry) =>
			`${entry.title}\n${entry.text}`.toLocaleLowerCase().includes(needle)
		)
		.slice(0, 100);
}
