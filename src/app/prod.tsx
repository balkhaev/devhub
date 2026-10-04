import { useCallback, useEffect, useState } from "react";

import type {
	ProdApplication,
	ProdDeployment,
	ProdProject,
	ProdResource,
	ProdStatus,
	ProdView,
} from "../coolify";
import type { ProjectView } from "../hub";
import { readHub } from "./api";
import { projectRoute } from "./project-ui";
import { cx, since } from "./words";

/** Production next to development: what Coolify runs for each project, read-only. */

const PROD_DOT: Record<ProdStatus["state"], string> = {
	degraded: "dot--unhealthy",
	running: "dot--running",
	starting: "dot--starting",
	stopped: "dot--crashed",
	unknown: "",
};
const PROD_WORDS: Record<ProdStatus["state"], string> = {
	degraded: "работает с ошибками",
	running: "работает",
	starting: "запускается",
	stopped: "остановлено",
	unknown: "неизвестно",
};
const DEPLOY_WORDS: Record<string, string> = {
	"cancelled-by-user": "отменён",
	failed: "ошибка",
	finished: "готово",
	in_progress: "идёт",
	queued: "в очереди",
};
const DEPLOY_TONE: Record<string, string> = { failed: "bad", finished: "ok" };
const SCHEME = /^https?:\/\//;
const STANDALONE = /^standalone-/;
const TRIGGER_WORDS: Record<ProdDeployment["trigger"], string> = {
	api: "API",
	manual: "вручную",
	rollback: "откат",
	webhook: "push",
};

const at = (value: string | null): number | null => {
	const time = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(time) ? null : time;
};

export function useProd(): {
	error: string | null;
	loading: boolean;
	refresh: () => void;
	view: ProdView | null;
} {
	const [view, setView] = useState<ProdView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const load = useCallback((fresh: boolean) => {
		setLoading(true);
		readHub<ProdView>(`/api/prod${fresh ? "?refresh=1" : ""}`)
			.then((next) => {
				setView(next);
				setError(next.error);
			})
			.catch((reason: unknown) => setError((reason as Error).message))
			.finally(() => setLoading(false));
	}, []);
	useEffect(() => load(false), [load]);
	const refresh = useCallback(() => load(true), [load]);
	return { error, loading, refresh, view };
}

function StatusDot({ status }: { status: ProdStatus }) {
	return (
		<span
			className={cx("dot", PROD_DOT[status.state])}
			title={`${PROD_WORDS[status.state]} · ${status.raw}`}
		/>
	);
}

function Deployments({ uuid }: { uuid: string }) {
	const [list, setList] = useState<ProdDeployment[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		readHub<ProdDeployment[]>(
			`/api/prod/apps/${encodeURIComponent(uuid)}/deployments`
		)
			.then(setList)
			.catch((reason: unknown) => setError((reason as Error).message));
	}, [uuid]);
	if (error) {
		return <p className="error">{error}</p>;
	}
	if (!list) {
		return <p className="muted small">Читаю деплои…</p>;
	}
	if (list.length === 0) {
		return <p className="muted small">Деплоев ещё не было.</p>;
	}
	return (
		<ul className="prod-deployments">
			{list.map((deployment) => {
				const created = at(deployment.createdAt);
				return (
					<li className="prod-deploy" key={deployment.uuid}>
						<span
							className={cx(
								"prod-badge",
								`prod-badge--${DEPLOY_TONE[deployment.status] ?? "busy"}`
							)}
						>
							{DEPLOY_WORDS[deployment.status] ?? deployment.status}
						</span>
						<code>{deployment.commit?.slice(0, 7) ?? "—"}</code>
						<span
							className="prod-deploy__message"
							title={deployment.message ?? undefined}
						>
							{deployment.message ?? ""}
						</span>
						<span className="muted small">
							{created ? `${since(created)} назад · ` : ""}
							{TRIGGER_WORDS[deployment.trigger]}
						</span>
						{deployment.console ? (
							<a
								className="small"
								href={deployment.console}
								rel="noopener"
								target="_blank"
							>
								лог ↗
							</a>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

const LOG_LINES = 200;

function Logs({ uuid }: { uuid: string }) {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		setError(null);
		readHub<{ logs: string }>(
			`/api/prod/apps/${encodeURIComponent(uuid)}/logs?lines=${LOG_LINES}`
		)
			.then((body) => setText(body.logs))
			.catch((reason: unknown) => setError((reason as Error).message));
	}, [uuid]);
	useEffect(load, [load]);
	return (
		<div className="prod-logs">
			<div className="log__bar">
				<button className="button button--small" onClick={load} type="button">
					Обновить
				</button>
				<span className="muted small">последние {LOG_LINES} строк</span>
			</div>
			{error ? <p className="error">{error}</p> : null}
			<pre className="log__text prod-logs__text">
				{text === null ? "Читаю логи…" : text || "Лог пуст."}
			</pre>
		</div>
	);
}

function Application({ app }: { app: ProdApplication }) {
	const [open, setOpen] = useState<"deployments" | "logs" | null>(null);
	const toggle = (what: "deployments" | "logs") => () =>
		setOpen((current) => (current === what ? null : what));
	const online = at(app.lastOnlineAt);
	return (
		<li className="prod-app">
			<div className="prod-app__head">
				<StatusDot status={app.status} />
				<strong>{app.name}</strong>
				<span className="muted small">
					{PROD_WORDS[app.status.state]}
					{app.status.state !== "running" && online
						? ` · был в сети ${since(online)} назад`
						: ""}
				</span>
				<span className="prod-app__actions">
					<button
						aria-expanded={open === "deployments"}
						className="button button--small"
						onClick={toggle("deployments")}
						type="button"
					>
						Деплои
					</button>
					<button
						aria-expanded={open === "logs"}
						className="button button--small"
						onClick={toggle("logs")}
						type="button"
					>
						Логи
					</button>
					{app.console ? (
						<a
							className="button button--small"
							href={app.console}
							rel="noopener"
							target="_blank"
						>
							Coolify ↗
						</a>
					) : null}
				</span>
			</div>
			<div className="prod-app__facts muted small">
				{app.domains.map((domain) => (
					<a href={domain} key={domain} rel="noopener" target="_blank">
						{domain.replace(SCHEME, "")} ↗
					</a>
				))}
				{app.domains.length === 0 ? <span>без домена</span> : null}
				{app.commit ? (
					<span>
						коммит <code>{app.commit.slice(0, 7)}</code>
					</span>
				) : null}
				{app.branch && app.repository ? (
					<span>
						{app.repository}@{app.branch}
					</span>
				) : null}
				{app.environment ? <span>{app.environment}</span> : null}
			</div>
			{open === "deployments" ? <Deployments uuid={app.uuid} /> : null}
			{open === "logs" ? <Logs uuid={app.uuid} /> : null}
		</li>
	);
}

function Resources({ resources }: { resources: ProdResource[] }) {
	if (resources.length === 0) {
		return null;
	}
	return (
		<div className="chips">
			{resources.map((resource) => (
				<a
					className="chip"
					href={resource.console ?? undefined}
					key={resource.uuid}
					rel="noopener"
					target="_blank"
					title={`${resource.kind === "database" ? "база" : "сервис"} · ${resource.status.raw}`}
				>
					<StatusDot status={resource.status} />
					{resource.name}
					{resource.type ? (
						<span className="muted small">
							{resource.type.replace(STANDALONE, "")}
						</span>
					) : null}
				</a>
			))}
		</div>
	);
}

function ProdProjectBody({ project }: { project: ProdProject }) {
	return (
		<>
			<ul className="prod-apps">
				{project.applications.map((app) => (
					<Application app={app} key={app.uuid} />
				))}
			</ul>
			<Resources resources={project.resources} />
		</>
	);
}

function ProdState({
	error,
	loading,
	view,
}: {
	error: string | null;
	loading: boolean;
	view: ProdView | null;
}) {
	if (error) {
		return <p className="error">{error}</p>;
	}
	if (!view) {
		return <p className="muted">{loading ? "Спрашиваю Coolify…" : ""}</p>;
	}
	if (!view.configured) {
		return (
			<p className="note">
				Coolify не настроен. Добавьте в <code>services.json</code> блок{" "}
				<code>
					{
						'"coolify": { "url": "https://…", "tokenEnv": "COOLIFY_ACCESS_TOKEN" }'
					}
				</code>{" "}
				и задайте токен в переменной окружения.
			</p>
		);
	}
	return null;
}

/** The production section of a project page. */
export function ProjectProd({ project }: { project: ProjectView }) {
	const { error, loading, refresh, view } = useProd();
	const prod = view?.projects.find((entry) => entry.id === project.id);
	return (
		<section>
			<h2 className="section-title prod-title">
				Прод
				{view?.url ? <span className="muted small">Coolify</span> : null}
				<button
					className="button button--small"
					disabled={loading}
					onClick={refresh}
					type="button"
				>
					{loading ? "Обновляю…" : "Обновить"}
				</button>
			</h2>
			<ProdState error={error} loading={loading} view={view} />
			{view?.configured && !error && !prod ? (
				<p className="muted">
					В Coolify нет приложений этого проекта. Сопоставление идёт по
					git-репозиторию и имени проекта; явную связь задаёт{" "}
					<code>coolify.links</code> в services.json.
				</p>
			) : null}
			{prod ? <ProdProjectBody project={prod} /> : null}
		</section>
	);
}

/** Everything Coolify runs, by project. */
export function ProdPage({ projects }: { projects: ProjectView[] }) {
	const { error, loading, refresh, view } = useProd();
	const names = new Map(projects.map((project) => [project.id, project.name]));
	const apps = view?.projects.flatMap((project) => project.applications) ?? [];
	const down = apps.filter((app) => app.status.state !== "running");
	return (
		<div className="overview">
			<header className="prod-head">
				<div>
					<h1>Прод</h1>
					<p className="muted">
						{view?.url ? (
							<>
								<a href={view.url} rel="noopener" target="_blank">
									{view.url.replace(SCHEME, "")} ↗
								</a>
								{view.version ? ` · Coolify ${view.version}` : ""}
								{` · ${apps.length} приложений, не работают ${down.length}`}
							</>
						) : (
							"Приложения проектов в Coolify"
						)}
					</p>
				</div>
				<button
					className="button"
					disabled={loading}
					onClick={refresh}
					type="button"
				>
					{loading ? "Обновляю…" : "Обновить"}
				</button>
			</header>
			<ProdState error={error} loading={loading} view={view} />
			<div className="cards cards--prod">
				{(view?.projects ?? []).map((project) => (
					<section className="card" key={project.id}>
						<div className="card__head">
							<div className="card__title">
								<h2>
									<a href={`#/${projectRoute(project.id)}`}>
										{names.get(project.id) ?? project.id}
									</a>
								</h2>
								<span className="muted small">
									Coolify: {project.coolifyProjects.join(", ") || "—"}
								</span>
							</div>
						</div>
						<ProdProjectBody project={project} />
					</section>
				))}
			</div>
			{view && view.unmatched.length > 0 ? (
				<section>
					<h2 className="section-title">Без проекта в пульте</h2>
					<ul className="prod-apps card">
						{view.unmatched.map((app) => (
							<Application app={app} key={app.uuid} />
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
