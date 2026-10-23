import { z } from "zod";

const id = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(300);
const text = z.string().max(50_000);
const coordinate = z.number().finite().min(-20_000).max(20_000);

export const canvasNodeSchema = z.strictObject({
	color: z.enum(["amber", "blue", "green", "purple"]),
	height: z.number().min(90).max(1000),
	id,
	kind: z.enum(["note", "process", "decision"]),
	text,
	title,
	width: z.number().min(140).max(1000),
	x: coordinate,
	y: coordinate,
});
export const canvasEdgeSchema = z.strictObject({
	from: id,
	id,
	label: z.string().max(300),
	to: id,
});
export const kanbanColumnSchema = z.strictObject({ id, title });
export const kanbanCardSchema = z.strictObject({
	columnId: id,
	id,
	labels: z.array(z.string().trim().min(1).max(60)).max(20),
	text,
	title,
});

export const knowledgeOperationSchema = z.discriminatedUnion("type", [
	z.strictObject({
		node: canvasNodeSchema,
		type: z.literal("canvas.node.put"),
	}),
	z.strictObject({ id, type: z.literal("canvas.node.delete") }),
	z.strictObject({
		edge: canvasEdgeSchema,
		type: z.literal("canvas.edge.put"),
	}),
	z.strictObject({ id, type: z.literal("canvas.edge.delete") }),
	z.strictObject({
		column: kanbanColumnSchema,
		type: z.literal("kanban.column.put"),
	}),
	z.strictObject({ id, type: z.literal("kanban.column.delete") }),
	z.strictObject({
		beforeId: id.optional(),
		card: kanbanCardSchema,
		type: z.literal("kanban.card.put"),
	}),
	z.strictObject({ id, type: z.literal("kanban.card.delete") }),
	z.strictObject({
		beforeId: id.optional(),
		columnId: id,
		id,
		type: z.literal("kanban.card.move"),
	}),
]);

export const knowledgeChangeSchema = z.strictObject({
	operations: z.array(knowledgeOperationSchema).min(1).max(200),
	revision: z.number().int().nonnegative(),
});

export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type KanbanCard = z.infer<typeof kanbanCardSchema>;
export type KanbanColumn = z.infer<typeof kanbanColumnSchema>;
export type KnowledgeOperation = z.infer<typeof knowledgeOperationSchema>;
export type KnowledgeChange = z.infer<typeof knowledgeChangeSchema>;

export interface ProjectKnowledge {
	canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] };
	kanban: { columns: KanbanColumn[]; cards: KanbanCard[] };
	revision: number;
	updatedAt: string | null;
}

export function emptyKnowledge(): ProjectKnowledge {
	return {
		canvas: { edges: [], nodes: [] },
		kanban: {
			cards: [],
			columns: [
				{ id: "backlog", title: "Запланировано" },
				{ id: "in-progress", title: "В работе" },
				{ id: "done", title: "Готово" },
			],
		},
		revision: 0,
		updatedAt: null,
	};
}
