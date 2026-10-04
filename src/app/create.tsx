import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useState,
} from "react";

import type { CreateJob, Template } from "../create";
import { readHub, sendHub } from "./api";
import { projectRoute } from "./project-ui";
import { cx } from "./words";

/** A new project from a generator, registered with the hub in the same step. */

const NAME = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const POLL_MS = 1000;

const TEMPLATES: { description: string; id: Template; title: string }[] = [
	{
		description:
			"Monorepo: Next.js, Hono на Bun, tRPC, Better Auth, Drizzle + Postgres в Docker, Turborepo, Ultracite, Dockerfile для прода.",
		id: "bts",
		title: "Better-T-Stack",
	},
	{
		description:
			"Чистый проект на uv: пакет в src/, pytest и ruff. С веб-сервером — FastAPI с /health и Dockerfile.",
		id: "python",
		title: "Python",
	},
];

function useJob(id: string | null): CreateJob | null {
	const [job, setJob] = useState<CreateJob | null>(null);
	useEffect(() => {
		if (!id) {
			setJob(null);
			return;
		}
		let stopped = false;
		const poll = async () => {
			try {
				const next = await readHub<CreateJob>(`/api/create/${id}`);
				if (stopped) {
					return;
				}
				setJob(next);
				if (next.status === "running") {
					setTimeout(poll, POLL_MS);
				}
			} catch {
				if (!stopped) {
					setTimeout(poll, POLL_MS);
				}
			}
		};
		poll();
		return () => {
			stopped = true;
		};
	}, [id]);
	return job;
}

export function CreatePage() {
	const [template, setTemplate] = useState<Template>("bts");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [web, setWeb] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [jobId, setJobId] = useState<string | null>(null);
	const job = useJob(jobId);
	const valid = NAME.test(name) && !name.includes("--");
	const chooseTemplate = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setTemplate(event.target.value === "python" ? "python" : "bts"),
		[]
	);
	const changeName = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setName(event.target.value.toLowerCase()),
		[]
	);
	const changeDescription = useCallback(
		(event: ChangeEvent<HTMLInputElement>) =>
			setDescription(event.target.value),
		[]
	);
	const changeWeb = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => setWeb(event.target.checked),
		[]
	);
	const submit = useCallback(
		async (event: FormEvent) => {
			event.preventDefault();
			setPending(true);
			setError(null);
			try {
				const started = await sendHub<CreateJob>("/api/create", {
					description,
					name,
					template,
					web,
				});
				setJobId(started.id);
			} catch (reason) {
				setError((reason as Error).message);
			} finally {
				setPending(false);
			}
		},
		[description, name, template, web]
	);
	const running = job?.status === "running";
	return (
		<div className="overview create">
			<header>
				<h1>Новый проект</h1>
				<p className="muted">
					Проект создаётся в папке проектов (<code>code</code> из
					services.json), получает свободные порты, devhub.json, режим MVP,
					инструкции для агентов и первый коммит в <code>main</code>. Remote и
					деплой подключаются потом.
				</p>
			</header>
			<form className="card create__form" onSubmit={submit}>
				<fieldset className="create__templates" disabled={running}>
					<legend className="section-title">Шаблон</legend>
					{TEMPLATES.map((entry) => (
						<label
							className={cx(
								"create__template",
								template === entry.id && "create__template--selected"
							)}
							key={entry.id}
						>
							<input
								checked={template === entry.id}
								name="template"
								onChange={chooseTemplate}
								type="radio"
								value={entry.id}
							/>
							<strong>{entry.title}</strong>
							<span className="muted small">{entry.description}</span>
						</label>
					))}
				</fieldset>
				<label className="create__field">
					<span>Имя папки и проекта</span>
					<input
						autoComplete="off"
						disabled={running}
						onChange={changeName}
						pattern="[a-z][a-z0-9\-]{0,38}[a-z0-9]"
						placeholder="my-app"
						required
						spellCheck={false}
						value={name}
					/>
					<span className="muted small">
						латиница, цифры и дефис; станет id в пульте
					</span>
				</label>
				<label className="create__field">
					<span>Описание</span>
					<input
						disabled={running}
						maxLength={200}
						onChange={changeDescription}
						placeholder="Для чего проект"
						value={description}
					/>
				</label>
				{template === "python" ? (
					<label className="create__check">
						<input
							checked={web}
							disabled={running}
							onChange={changeWeb}
							type="checkbox"
						/>
						Веб-сервер FastAPI (dev-сервис в пульте)
					</label>
				) : null}
				<div className="service__actions">
					<button
						className="button button--primary"
						disabled={!valid || pending || running}
						type="submit"
					>
						{running ? "Создаю…" : "Создать проект"}
					</button>
					{template === "bts" ? (
						<span className="muted small">
							Установка зависимостей занимает около минуты.
						</span>
					) : null}
				</div>
				{error ? <p className="error">{error}</p> : null}
			</form>
			{job ? (
				<section className="create__job">
					<h2 className="section-title">
						{job.name}:{" "}
						{
							{
								done: "готово",
								failed: "не получилось",
								running: "создаётся…",
							}[job.status]
						}
					</h2>
					{job.status === "done" ? (
						<p>
							<a
								className="button button--primary"
								href={`#/${projectRoute(job.name)}`}
							>
								Открыть проект
							</a>{" "}
							<code>{job.path}</code>
						</p>
					) : null}
					{job.error ? <p className="error">{job.error}</p> : null}
					<pre className="log__text create__log">{job.log}</pre>
				</section>
			) : null}
		</div>
	);
}
