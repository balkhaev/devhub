import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { KnowledgeStore, searchKnowledge } from "../src/knowledge";
import type { CanvasNode } from "../src/knowledge-schema";
import { createKnowledgeMcp } from "../src/mcp";

const node: CanvasNode = {
	color: "blue",
	height: 140,
	id: "architecture",
	kind: "process",
	text: "Решение: SQLite. Источник: https://example.test/spec",
	title: "Архитектура",
	width: 240,
	x: 0,
	y: 0,
};

async function cleanup(folder: string) {
	const target = resolve(folder);
	if (
		dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
		!basename(target).startsWith("devhub-knowledge-")
	) {
		throw new Error("Unsafe fixture path");
	}
	await rm(target, { force: true, recursive: true });
}

test("knowledge persists across restart, isolates projects, rejects stale writes and rolls back invalid batches", async () => {
	const folder = await mkdtemp(join(tmpdir(), "devhub-knowledge-"));
	let store = new KnowledgeStore(join(folder, "knowledge.sqlite"));
	try {
		const first = store.change("/projects/one", {
			operations: [{ node, type: "canvas.node.put" }],
			revision: 0,
		});
		expect(first.revision).toBe(1);
		expect(store.read("/projects/two").canvas.nodes).toEqual([]);
		expect(() =>
			store.change("/projects/one", {
				operations: [{ id: node.id, type: "canvas.node.delete" }],
				revision: 0,
			})
		).toThrow("Доска изменилась");
		expect(() =>
			store.change("/projects/one", {
				operations: [
					{ node: { ...node, id: "second" }, type: "canvas.node.put" },
					{
						edge: {
							from: node.id,
							id: "broken",
							label: "invalid",
							to: "missing",
						},
						type: "canvas.edge.put",
					},
				],
				revision: 1,
			})
		).toThrow("Связь должна");
		expect(store.read("/projects/one")).toEqual(first);
		store.close();
		store = new KnowledgeStore(join(folder, "knowledge.sqlite"));
		expect(store.read("/projects/one")).toEqual(first);
		expect(searchKnowledge(first, "SQLITE")[0]?.id).toBe(node.id);
		expect(() =>
			store.change("/projects/one", {
				operations: [
					{
						node: { ...node, x: Number.POSITIVE_INFINITY },
						type: "canvas.node.put",
					},
				],
				revision: 1,
			})
		).toThrow();
	} finally {
		store.close();
		await cleanup(folder);
	}
});

test("connected node deletion is atomic; kanban moves preserve order and protect populated columns", () => {
	const store = new KnowledgeStore(":memory:");
	try {
		const card = {
			columnId: "backlog",
			id: "one",
			labels: ["api"],
			text: "критерии готовности",
			title: "Проверить",
		};
		store.change("/app", {
			operations: [
				{ node, type: "canvas.node.put" },
				{ node: { ...node, id: "database" }, type: "canvas.node.put" },
				{
					edge: { from: node.id, id: "link", label: "хранит", to: "database" },
					type: "canvas.edge.put",
				},
				{ card, type: "kanban.card.put" },
				{ card: { ...card, id: "two" }, type: "kanban.card.put" },
			],
			revision: 0,
		});
		expect(() =>
			store.change("/app", {
				operations: [{ id: "backlog", type: "kanban.column.delete" }],
				revision: 1,
			})
		).toThrow("Сначала перенесите");
		const moved = store.change("/app", {
			operations: [
				{ id: node.id, type: "canvas.node.delete" },
				{
					beforeId: "one",
					columnId: "backlog",
					id: "two",
					type: "kanban.card.move",
				},
			],
			revision: 1,
		});
		expect(moved.canvas.edges).toEqual([]);
		expect(moved.kanban.cards.map((entry) => entry.id)).toEqual(["two", "one"]);
		expect(searchKnowledge(moved, "API")).toHaveLength(2);
		const final = store.change("/app", {
			operations: [{ columnId: "done", id: "two", type: "kanban.card.move" }],
			revision: 2,
		});
		expect(final.kanban.cards.at(-1)).toMatchObject({
			columnId: "done",
			id: "two",
		});
	} finally {
		store.close();
	}
});

test("MCP negotiates capabilities, lists tools, writes and searches the same data, and reports conflicts", async () => {
	const store = new KnowledgeStore(":memory:");
	const server = createKnowledgeMcp((path, body) => {
		if (path === "/api/knowledge") {
			return Promise.resolve({ projects: [{ id: "app", name: "App" }] });
		}
		if (body) {
			return Promise.resolve(store.change("/app", body));
		}
		const state = store.read("/app");
		const query = new URL(path, "http://localhost").searchParams.get("q");
		return Promise.resolve(
			query ? { hits: searchKnowledge(state, query) } : state
		);
	});
	const client = new Client({ name: "fixture-agent", version: "1" });
	const [one, two] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(one);
		await client.connect(two);
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
			"projects_list",
			"knowledge_read",
			"knowledge_search",
			"knowledge_apply",
		]);
		const tools = await client.listTools();
		expect(JSON.stringify(tools)).toContain("kanban.card.move");
		const written = await client.callTool({
			arguments: {
				operations: [{ node, type: "canvas.node.put" }],
				project: "app",
				revision: 0,
			},
			name: "knowledge_apply",
		});
		expect(written.isError).not.toBe(true);
		const read = await client.callTool({
			arguments: { project: "app" },
			name: "knowledge_read",
		});
		expect(JSON.stringify(read)).toContain("Архитектура");
		const stale = await client.callTool({
			arguments: {
				operations: [{ id: node.id, type: "canvas.node.delete" }],
				project: "app",
				revision: 0,
			},
			name: "knowledge_apply",
		});
		expect(stale.isError).toBe(true);
		const search = await client.callTool({
			arguments: { project: "app", query: "sqlite" },
			name: "knowledge_search",
		});
		expect(JSON.stringify(search)).toContain("architecture");
	} finally {
		await client.close();
		await server.close();
		store.close();
	}
});

test("MCP stdio entrypoint starts without hub startup noise on the protocol stream", async () => {
	const client = new Client({ name: "stdio-fixture", version: "1" });
	const transport = new StdioClientTransport({
		args: [resolve(import.meta.dir, "../src/mcp.ts")],
		command: process.execPath,
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		expect((await client.listTools()).tools).toHaveLength(4);
	} finally {
		await client.close();
	}
});
