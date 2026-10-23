/** biome-ignore-all lint/performance/noJsxPropsBind: Entity-specific form and drag handlers do not cross memoized component boundaries. */
import {
	type DragEvent,
	type FormEvent,
	useEffect,
	useRef,
	useState,
} from "react";

import type {
	KanbanCard,
	KanbanColumn,
	ProjectKnowledge,
} from "../knowledge-schema";
import { useConfirm } from "./confirm";
import { DialogPortal } from "./dialog-portal";
import type { BoardChange } from "./knowledge-api";

function CardEditor({
	card,
	columns,
	busy,
	onClose,
	onSave,
	onDelete,
	error,
	refresh,
}: {
	card: KanbanCard;
	columns: KanbanColumn[];
	busy: boolean;
	onClose: () => void;
	onSave: (card: KanbanCard) => Promise<void>;
	onDelete: () => void;
	error: string;
	refresh: () => Promise<void>;
}) {
	const [draft, setDraft] = useState(card);
	const [labels, setLabels] = useState(card.labels.join(", "));
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSave({
			...draft,
			labels: [
				...new Set(
					labels
						.split(",")
						.map((label) => label.trim())
						.filter(Boolean)
				),
			],
		});
	};
	return (
		<DialogPortal>
			<dialog
				aria-label="Редактор карточки"
				className="kanban-dialog"
				onCancel={onClose}
				ref={dialog}
			>
				<form className="board-editor" onSubmit={submit}>
					{error ? (
						<div role="alert">
							<p className="error">{error}</p>
							<button
								className="button"
								disabled={busy}
								onClick={refresh}
								type="button"
							>
								Обновить доску
							</button>
						</div>
					) : null}
					<div className="board-editor__head">
						<div>
							<p className="eyebrow">Kanban</p>
							<h2>Карточка проекта</h2>
						</div>
						<button
							aria-label="Закрыть карточку"
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
							maxLength={300}
							onChange={(event) =>
								setDraft({ ...draft, title: event.target.value })
							}
							placeholder="Что нужно сделать?"
							required
							value={draft.title}
						/>
					</label>
					<label>
						Описание
						<textarea
							maxLength={50_000}
							onChange={(event) =>
								setDraft({ ...draft, text: event.target.value })
							}
							placeholder="Контекст, критерии готовности, решения и ссылки…"
							rows={10}
							value={draft.text}
						/>
					</label>
					<label>
						Колонка
						<select
							onChange={(event) =>
								setDraft({ ...draft, columnId: event.target.value })
							}
							value={draft.columnId}
						>
							{columns.map((column) => (
								<option key={column.id} value={column.id}>
									{column.title}
								</option>
							))}
						</select>
					</label>
					<label>
						Метки через запятую
						<input
							maxLength={1200}
							onChange={(event) => setLabels(event.target.value)}
							placeholder="архитектура, исследование"
							value={labels}
						/>
					</label>
					<div className="board-editor__actions">
						<button
							className="button button--primary"
							disabled={busy || !draft.title.trim()}
							type="submit"
						>
							Сохранить карточку
						</button>
						<button className="button" onClick={onClose} type="button">
							Отмена
						</button>
						<button
							className="button button--danger"
							disabled={busy}
							onClick={onDelete}
							type="button"
						>
							Удалить
						</button>
					</div>
					<code className="muted small">{card.id}</code>
				</form>
			</dialog>
		</DialogPortal>
	);
}

export function KanbanBoard({
	board,
	busy,
	change,
	query,
	error,
	refresh,
}: {
	board: ProjectKnowledge["kanban"];
	busy: boolean;
	change: BoardChange;
	query: string;
	error: string;
	refresh: () => Promise<void>;
}) {
	const [editing, setEditing] = useState<KanbanCard | null>(null);
	const [newCard, setNewCard] = useState(false);
	const [column, setColumn] = useState<KanbanColumn | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);
	const [confirm, dialog] = useConfirm();
	const add = (columnId: string) => {
		setNewCard(true);
		setEditing({
			columnId,
			id: crypto.randomUUID(),
			labels: [],
			text: "",
			title: "",
		});
	};
	const save = async (card: KanbanCard) => {
		const latest = board.cards.find((entry) => entry.id === card.id);
		if (
			!newCard &&
			JSON.stringify(latest) !== JSON.stringify(editing) &&
			!(await confirm(
				"Эта карточка изменилась после открытия редактора. Сохранить вашу версию поверх текущей?"
			))
		) {
			return;
		}
		if (await change([{ card, type: "kanban.card.put" }])) {
			setEditing(null);
		}
	};
	const remove = async () => {
		if (!(editing && (await confirm("Удалить карточку?")))) {
			return;
		}
		if (
			!board.cards.some((card) => card.id === editing.id) ||
			(await change([{ id: editing.id, type: "kanban.card.delete" }]))
		) {
			setEditing(null);
		}
	};
	const saveColumn = async (event: FormEvent) => {
		event.preventDefault();
		if (column && (await change([{ column, type: "kanban.column.put" }]))) {
			setColumn(null);
		}
	};
	const removeColumn = async (entry: KanbanColumn) => {
		if (await confirm(`Удалить пустую колонку «${entry.title}»?`)) {
			await change([{ id: entry.id, type: "kanban.column.delete" }]);
		}
	};
	const drop = (event: DragEvent, columnId: string, beforeId?: string) => {
		event.preventDefault();
		event.stopPropagation();
		const id = event.dataTransfer.getData("application/x-devhub-card");
		setOver(null);
		setDragging(null);
		if (
			!busy &&
			board.cards.some((card) => card.id === id) &&
			beforeId !== id
		) {
			change([
				{
					columnId,
					id,
					type: "kanban.card.move",
					...(beforeId ? { beforeId } : {}),
				},
			]);
		}
	};
	return (
		<>
			<div className="canvas-tools">
				<p className="muted small">
					{board.cards.length} карточек · Перетаскивайте между колонками или
					выберите колонку в карточке.
				</p>
				<button
					className="button"
					disabled={busy || board.columns.length >= 30}
					onClick={() => setColumn({ id: crypto.randomUUID(), title: "" })}
					type="button"
				>
					+ Колонка
				</button>
			</div>
			{column ? (
				<form className="column-form" onSubmit={saveColumn}>
					<label>
						Название колонки
						<input
							maxLength={300}
							onChange={(event) =>
								setColumn({ ...column, title: event.target.value })
							}
							required
							value={column.title}
						/>
					</label>
					<button
						className="button button--primary"
						disabled={busy || !column.title.trim()}
						type="submit"
					>
						Сохранить колонку
					</button>
					<button
						className="button"
						onClick={() => setColumn(null)}
						type="button"
					>
						Отмена
					</button>
				</form>
			) : null}
			<section aria-label="Kanban доска" className="kanban-board">
				{board.columns.map((entry, columnIndex) => {
					const all = board.cards.filter((card) => card.columnId === entry.id);
					const cards = all.filter((card) =>
						`${card.title} ${card.text} ${card.labels.join(" ")}`
							.toLocaleLowerCase()
							.includes(query.trim().toLocaleLowerCase())
					);
					return (
						// biome-ignore lint/a11y/noNoninteractiveElementInteractions: Dragging supplements the keyboard-accessible column selector in the card editor.
						<section
							aria-label={entry.title}
							className={`kanban-column${over === entry.id ? "kanban-column--over" : ""}`}
							key={entry.id}
							onDragOver={(event) => {
								if (dragging) {
									event.preventDefault();
									setOver(entry.id);
								}
							}}
							onDrop={(event) => drop(event, entry.id)}
						>
							<header className="kanban-column__head">
								<span
									className={`kanban-indicator kanban-indicator--${columnIndex % 4}`}
								/>
								<h2>{entry.title}</h2>
								<span className="kanban-count">{all.length}</span>
								<button
									aria-label={`Изменить колонку ${entry.title}`}
									className="button"
									disabled={busy}
									onClick={() => setColumn(entry)}
									type="button"
								>
									✎
								</button>
								<button
									aria-label={`Удалить колонку ${entry.title}`}
									className="button"
									disabled={
										busy || all.length > 0 || board.columns.length === 1
									}
									onClick={() => removeColumn(entry)}
									title={
										all.length
											? "Сначала перенесите карточки"
											: "Удалить пустую колонку"
									}
									type="button"
								>
									×
								</button>
							</header>
							<div className="kanban-cards">
								{cards.map((card, index) => (
									// biome-ignore lint/a11y/noNoninteractiveElementInteractions: Dragging supplements the card's keyboard-accessible reorder buttons.
									<article
										className={`kanban-card${dragging === card.id ? "kanban-card--dragging" : ""}`}
										draggable={!busy}
										key={card.id}
										onDragEnd={() => {
											setDragging(null);
											setOver(null);
										}}
										onDragOver={(event) => {
											if (dragging) {
												event.preventDefault();
											}
										}}
										onDragStart={(event) => {
											event.dataTransfer.setData(
												"application/x-devhub-card",
												card.id
											);
											event.dataTransfer.effectAllowed = "move";
											setDragging(card.id);
										}}
										onDrop={(event) => drop(event, entry.id, card.id)}
									>
										<button
											className="kanban-card__open"
											onClick={() => {
												setNewCard(false);
												setEditing(card);
											}}
											type="button"
										>
											<strong>{card.title}</strong>
											{card.text ? (
												<span className="kanban-card__description">
													{card.text}
												</span>
											) : null}
											<span className="kanban-labels">
												{card.labels.map((label) => (
													<span key={label}>{label}</span>
												))}
											</span>
										</button>
										<div className="kanban-card__order">
											<button
												aria-label={`Поднять карточку ${card.title}`}
												className="button"
												disabled={busy || index === 0 || !!query}
												onClick={() =>
													change([
														{
															beforeId: cards[index - 1]?.id,
															columnId: entry.id,
															id: card.id,
															type: "kanban.card.move",
														},
													])
												}
												type="button"
											>
												↑
											</button>
											<button
												aria-label={`Опустить карточку ${card.title}`}
												className="button"
												disabled={busy || index === cards.length - 1 || !!query}
												onClick={() =>
													change([
														{
															beforeId: cards[index + 2]?.id,
															columnId: entry.id,
															id: card.id,
															type: "kanban.card.move",
														},
													])
												}
												type="button"
											>
												↓
											</button>
										</div>
									</article>
								))}
							</div>
							{cards.length === 0 ? (
								<div className="kanban-empty">
									<span aria-hidden="true">{query ? "⌕" : "+"}</span>
									<p>{query ? "Нет совпадений" : "Здесь появятся карточки"}</p>
								</div>
							) : null}
							<button
								className="kanban-add"
								disabled={busy}
								onClick={() => add(entry.id)}
								type="button"
							>
								+ Добавить карточку
							</button>
						</section>
					);
				})}
			</section>
			{editing ? (
				<CardEditor
					busy={busy}
					card={editing}
					columns={board.columns}
					error={error}
					key={editing.id}
					onClose={() => setEditing(null)}
					onDelete={remove}
					onSave={save}
					refresh={refresh}
				/>
			) : null}
			{dialog}
		</>
	);
}
