/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: React and pointer callbacks mutate refs between renders; the analyzer incorrectly treats their initial values as constant. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Entity-specific form and pointer handlers do not cross memoized component boundaries. */
import {
	type FormEvent,
	type PointerEvent,
	useId,
	useRef,
	useState,
} from "react";

import type {
	CanvasEdge,
	CanvasNode,
	ProjectKnowledge,
} from "../knowledge-schema";
import { useConfirm } from "./confirm";
import type { BoardChange } from "./knowledge-api";

const KIND = { decision: "Решение", note: "Заметка", process: "Процесс" };

function NodeEditor({
	node,
	busy,
	onSave,
	onClose,
	onDelete,
}: {
	node: CanvasNode;
	busy: boolean;
	onSave: (node: CanvasNode) => Promise<void>;
	onClose: () => void;
	onDelete: () => void;
}) {
	const [draft, setDraft] = useState(node);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSave(draft);
	};
	return (
		<form className="board-editor" onSubmit={submit}>
			<div className="board-editor__head">
				<h2>Блок</h2>
				<button
					aria-label="Закрыть редактор блока"
					className="button"
					onClick={onClose}
					type="button"
				>
					×
				</button>
			</div>
			<label>
				Название
				<input
					autoComplete="off"
					maxLength={300}
					onChange={(event) =>
						setDraft({ ...draft, title: event.target.value })
					}
					required
					value={draft.title}
				/>
			</label>
			<label>
				Содержание
				<textarea
					maxLength={50_000}
					onChange={(event) => setDraft({ ...draft, text: event.target.value })}
					placeholder="Решение, контекст, ссылки на источники…"
					rows={9}
					value={draft.text}
				/>
			</label>
			<p className="muted small">Можно хранить Markdown и ссылки.</p>
			<div className="board-fields">
				<label>
					Форма
					<select
						onChange={(event) =>
							setDraft({
								...draft,
								kind: event.target.value as CanvasNode["kind"],
							})
						}
						value={draft.kind}
					>
						{Object.entries(KIND).map(([value, title]) => (
							<option key={value} value={value}>
								{title}
							</option>
						))}
					</select>
				</label>
				<label>
					Цвет
					<select
						onChange={(event) =>
							setDraft({
								...draft,
								color: event.target.value as CanvasNode["color"],
							})
						}
						value={draft.color}
					>
						<option value="amber">Янтарный</option>
						<option value="blue">Синий</option>
						<option value="green">Зелёный</option>
						<option value="purple">Фиолетовый</option>
					</select>
				</label>
			</div>
			<div className="board-fields">
				<label>
					X
					<input
						max={20_000}
						min={-20_000}
						onChange={(event) =>
							setDraft({ ...draft, x: Number(event.target.value) })
						}
						type="number"
						value={draft.x}
					/>
				</label>
				<label>
					Y
					<input
						max={20_000}
						min={-20_000}
						onChange={(event) =>
							setDraft({ ...draft, y: Number(event.target.value) })
						}
						type="number"
						value={draft.y}
					/>
				</label>
			</div>
			<div className="board-fields">
				<label>
					Ширина
					<input
						max={1000}
						min={140}
						onChange={(event) =>
							setDraft({ ...draft, width: Number(event.target.value) })
						}
						type="number"
						value={draft.width}
					/>
				</label>
				<label>
					Высота
					<input
						max={1000}
						min={90}
						onChange={(event) =>
							setDraft({ ...draft, height: Number(event.target.value) })
						}
						type="number"
						value={draft.height}
					/>
				</label>
			</div>
			<button
				className="button button--primary"
				disabled={busy || !draft.title.trim()}
				type="submit"
			>
				Сохранить блок
			</button>
			<button
				className="button button--danger"
				disabled={busy}
				onClick={onDelete}
				type="button"
			>
				Удалить блок
			</button>
			<code className="muted small">{node.id}</code>
		</form>
	);
}

function ConnectionEditor({
	nodes,
	edges,
	busy,
	change,
}: {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	busy: boolean;
	change: BoardChange;
}) {
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [label, setLabel] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [confirm, dialog] = useConfirm();
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (
			await change([
				{
					edge: { from, id: editing ?? crypto.randomUUID(), label, to },
					type: "canvas.edge.put",
				},
			])
		) {
			setLabel("");
			setEditing(null);
		}
	};
	const remove = async (edge: CanvasEdge) => {
		if (await confirm("Удалить эту связь?")) {
			await change([{ id: edge.id, type: "canvas.edge.delete" }]);
		}
	};
	return (
		<section className="board-connections">
			<h2>{editing ? "Изменить связь" : "Связать блоки"}</h2>
			<form className="board-editor" onSubmit={submit}>
				<label>
					Откуда
					<select
						onChange={(event) => setFrom(event.target.value)}
						required
						value={from}
					>
						<option value="">Выберите блок</option>
						{nodes.map((node) => (
							<option key={node.id} value={node.id}>
								{node.title}
							</option>
						))}
					</select>
				</label>
				<label>
					Куда
					<select
						onChange={(event) => setTo(event.target.value)}
						required
						value={to}
					>
						<option value="">Выберите блок</option>
						{nodes
							.filter((node) => node.id !== from)
							.map((node) => (
								<option key={node.id} value={node.id}>
									{node.title}
								</option>
							))}
					</select>
				</label>
				<label>
					Подпись
					<input
						maxLength={300}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="Например: передаёт данные"
						value={label}
					/>
				</label>
				<button
					className="button"
					disabled={
						busy ||
						!from ||
						!to ||
						from === to ||
						!nodes.some((node) => node.id === from) ||
						!nodes.some((node) => node.id === to)
					}
					type="submit"
				>
					{editing ? "Сохранить связь" : "Добавить связь"}
				</button>
				{editing ? (
					<button
						className="button"
						onClick={() => {
							setEditing(null);
							setLabel("");
						}}
						type="button"
					>
						Отмена
					</button>
				) : null}
			</form>
			<ul className="connection-list">
				{edges.map((edge) => (
					<li key={edge.id}>
						<button
							className="connection-list__edit"
							onClick={() => {
								setEditing(edge.id);
								setFrom(edge.from);
								setTo(edge.to);
								setLabel(edge.label);
							}}
							type="button"
						>
							<strong>{edge.label || "Без подписи"}</strong>
							<span>
								{nodes.find((node) => node.id === edge.from)?.title} →{" "}
								{nodes.find((node) => node.id === edge.to)?.title}
							</span>
						</button>
						<button
							aria-label={`Удалить связь ${edge.label || edge.id}`}
							className="button"
							disabled={busy}
							onClick={() => remove(edge)}
							type="button"
						>
							×
						</button>
					</li>
				))}
			</ul>
			{dialog}
		</section>
	);
}

interface Drag {
	clientX: number;
	clientY: number;
	node: CanvasNode;
	x: number;
	y: number;
}

export function CanvasBoard({
	canvas,
	busy,
	change,
	query,
}: {
	canvas: ProjectKnowledge["canvas"];
	busy: boolean;
	change: BoardChange;
	query: string;
}) {
	const [zoom, setZoom] = useState(1);
	const [selected, setSelected] = useState<CanvasNode | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const moving = useRef<Drag | null>(null);
	const viewport = useRef<HTMLElement>(null);
	const pan = useRef<{
		x: number;
		y: number;
		left: number;
		top: number;
	} | null>(null);
	const marker = useId().replaceAll(":", "");
	const [confirm, dialog] = useConfirm();
	const offsetX = 80 - Math.min(0, ...canvas.nodes.map((node) => node.x));
	const offsetY = 80 - Math.min(0, ...canvas.nodes.map((node) => node.y));
	const width = Math.max(
		1600,
		...canvas.nodes.map((node) => node.x + node.width + offsetX + 300)
	);
	const height = Math.max(
		1000,
		...canvas.nodes.map((node) => node.y + node.height + offsetY + 300)
	);
	const nodes = canvas.nodes.map((node) =>
		drag?.node.id === node.id ? { ...node, x: drag.x, y: drag.y } : node
	);
	const start = (event: PointerEvent<HTMLButtonElement>, node: CanvasNode) => {
		if (busy || event.button !== 0) {
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		moving.current = {
			clientX: event.clientX,
			clientY: event.clientY,
			node,
			x: node.x,
			y: node.y,
		};
	};
	const move = (event: PointerEvent<HTMLButtonElement>) => {
		const previous = moving.current;
		if (!previous) {
			return;
		}
		const next = {
			...previous,
			x: Math.round(
				Math.max(
					-20_000,
					Math.min(
						20_000,
						previous.node.x + (event.clientX - previous.clientX) / zoom
					)
				)
			),
			y: Math.round(
				Math.max(
					-20_000,
					Math.min(
						20_000,
						previous.node.y + (event.clientY - previous.clientY) / zoom
					)
				)
			),
		};
		moving.current = next;
		setDrag(next);
	};
	const drop = async () => {
		const { current } = moving;
		moving.current = null;
		if (
			current &&
			(current.x !== current.node.x || current.y !== current.node.y)
		) {
			await change([
				{
					node: { ...current.node, x: current.x, y: current.y },
					type: "canvas.node.put",
				},
			]);
		}
		setDrag(null);
	};
	const add = async (kind: CanvasNode["kind"]) => {
		const node: CanvasNode = {
			color: kind === "decision" ? "purple" : "amber",
			height: 150,
			id: crypto.randomUUID(),
			kind,
			text: "",
			title: KIND[kind],
			width: 240,
			x: Math.max(
				-20_000,
				Math.min(
					20_000,
					Math.round(
						(viewport.current?.scrollLeft ?? 0) / zoom +
							60 +
							(canvas.nodes.length % 6) * 28 -
							offsetX
					)
				)
			),
			y: Math.max(
				-20_000,
				Math.min(
					20_000,
					Math.round(
						(viewport.current?.scrollTop ?? 0) / zoom +
							60 +
							(canvas.nodes.length % 6) * 28 -
							offsetY
					)
				)
			),
		};
		if (await change([{ node, type: "canvas.node.put" }])) {
			setSelected(node);
		}
	};
	const save = async (node: CanvasNode) => {
		const latest = canvas.nodes.find((entry) => entry.id === node.id);
		if (
			selected &&
			JSON.stringify({ ...latest, x: 0, y: 0 }) !==
				JSON.stringify({ ...selected, x: 0, y: 0 }) &&
			!(await confirm(
				"Этот блок изменился после открытия редактора. Сохранить вашу версию поверх текущей?"
			))
		) {
			return;
		}
		if (
			await change([
				{
					node: {
						...node,
						x: node.x === selected?.x ? (latest?.x ?? node.x) : node.x,
						y: node.y === selected?.y ? (latest?.y ?? node.y) : node.y,
					},
					type: "canvas.node.put",
				},
			])
		) {
			setSelected(null);
		}
	};
	const remove = async () => {
		if (
			selected &&
			(await confirm(`Удалить блок «${selected.title}» и его связи?`)) &&
			(await change([{ id: selected.id, type: "canvas.node.delete" }]))
		) {
			setSelected(null);
		}
	};
	const panStart = (event: PointerEvent<HTMLButtonElement>) => {
		if (!viewport.current) {
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		pan.current = {
			left: viewport.current.scrollLeft,
			top: viewport.current.scrollTop,
			x: event.clientX,
			y: event.clientY,
		};
	};
	const panMove = (event: PointerEvent<HTMLButtonElement>) => {
		if (!(pan.current && viewport.current)) {
			return;
		}
		viewport.current.scrollLeft =
			pan.current.left - (event.clientX - pan.current.x);
		viewport.current.scrollTop =
			pan.current.top - (event.clientY - pan.current.y);
	};
	return (
		<>
			<div className="canvas-tools">
				<div className="canvas-tools__add">
					{Object.entries(KIND).map(([kind, title]) => (
						<button
							className="button"
							disabled={busy}
							key={kind}
							onClick={() => add(kind as CanvasNode["kind"])}
							type="button"
						>
							+ {title}
						</button>
					))}
				</div>
				<div className="canvas-zoom">
					<button
						aria-label="Уменьшить масштаб"
						className="button"
						onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
						type="button"
					>
						−
					</button>
					<button className="button" onClick={() => setZoom(1)} type="button">
						{Math.round(zoom * 100)}%
					</button>
					<button
						aria-label="Увеличить масштаб"
						className="button"
						onClick={() => setZoom(Math.min(2, zoom + 0.25))}
						type="button"
					>
						+
					</button>
				</div>
			</div>
			<div className="canvas-layout">
				<section
					aria-label="Canvas доска"
					className="canvas-viewport"
					ref={viewport}
				>
					<div
						className="canvas-size"
						style={{ height: height * zoom, width: width * zoom }}
					>
						<div
							className="canvas-world"
							style={{ height, transform: `scale(${zoom})`, width }}
						>
							<button
								aria-label="Переместить поле доски"
								className="canvas-pan"
								onPointerCancel={() => {
									pan.current = null;
								}}
								onPointerDown={panStart}
								onPointerMove={panMove}
								onPointerUp={() => {
									pan.current = null;
								}}
								type="button"
							/>
							<svg
								aria-label="Связи схемы"
								className="canvas-edges"
								height={height}
								role="img"
								width={width}
							>
								<defs>
									<marker
										id={marker}
										markerHeight="8"
										markerWidth="8"
										orient="auto"
										refX="8"
										refY="4"
									>
										<path d="M0,0 L8,4 L0,8" fill="currentColor" />
									</marker>
								</defs>
								{canvas.edges.map((edge) => {
									const from = nodes.find((node) => node.id === edge.from);
									const to = nodes.find((node) => node.id === edge.to);
									if (!(from && to)) {
										return null;
									}
									const forward = to.x >= from.x;
									const x1 = from.x + (forward ? from.width : 0) + offsetX;
									const y1 = from.y + from.height / 2 + offsetY;
									const x2 = to.x + (forward ? 0 : to.width) + offsetX;
									const y2 = to.y + to.height / 2 + offsetY;
									const bend =
										Math.max(60, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
									return (
										<g key={edge.id}>
											<path
												d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
												markerEnd={`url(#${marker})`}
											/>
											<text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 12}>
												{edge.label}
											</text>
										</g>
									);
								})}
							</svg>
							{nodes.map((node) => {
								const matches = `${node.title} ${node.text}`
									.toLocaleLowerCase()
									.includes(query.trim().toLocaleLowerCase());
								return (
									<button
										aria-label={`Блок: ${node.title}`}
										aria-pressed={selected?.id === node.id}
										className={`canvas-node canvas-node--${node.color} canvas-node--${node.kind}${matches ? "" : "canvas-node--dim"}`}
										key={node.id}
										onClick={() => {
											if (!drag) {
												setSelected(node);
											}
										}}
										onPointerCancel={() => {
											moving.current = null;
											setDrag(null);
										}}
										onPointerDown={(event) => start(event, node)}
										onPointerMove={move}
										onPointerUp={drop}
										style={{
											height: node.height,
											left: node.x + offsetX,
											top: node.y + offsetY,
											width: node.width,
										}}
										type="button"
									>
										<span className="canvas-node__kind">{KIND[node.kind]}</span>
										<strong>{node.title}</strong>
										<span className="canvas-node__text">
											{node.text || "Нажмите, чтобы добавить содержание"}
										</span>
									</button>
								);
							})}
							{nodes.length === 0 ? (
								<div className="board-empty canvas-empty">
									<span aria-hidden="true">◇</span>
									<h2>Место для большой картины</h2>
									<p>
										Добавьте заметки, процессы и решения.
										<br />
										Соедините их, чтобы построить схему проекта.
									</p>
								</div>
							) : null}
						</div>
					</div>
				</section>
				<aside aria-label="Редактор canvas" className="canvas-inspector">
					{selected ? (
						<NodeEditor
							busy={busy}
							key={selected.id}
							node={selected}
							onClose={() => setSelected(null)}
							onDelete={remove}
							onSave={save}
						/>
					) : (
						<div className="canvas-hint">
							<h2>Canvas</h2>
							<p>
								Перетаскивайте блоки, чтобы выстроить схему. Потяните пустое
								поле для перемещения по доске.
							</p>
							<p>
								Выберите блок, чтобы записать детали или изменить форму и цвет.
							</p>
						</div>
					)}
					<ConnectionEditor
						busy={busy}
						change={change}
						edges={canvas.edges}
						nodes={canvas.nodes}
					/>
				</aside>
			</div>
			{dialog}
		</>
	);
}
