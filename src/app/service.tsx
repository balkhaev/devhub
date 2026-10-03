import {
	type MouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import type { ServiceView } from "../hub";
import type { Framing } from "../probes";
import { act, checkFrame, useLog } from "./api";
import { useConfirm } from "./confirm";
import { cx, isUp, STATUS_WORDS, since } from "./words";

/**
 * One service: its state and actions, its pages inside the hub, its log as it grows, and how it runs. A page once
 * opened stays loaded while the others are looked at, so switching to the log and back loses nothing. The page is
 * keyed by the service, so each service opens afresh.
 */

type Tab =
	| { kind: "ui"; label: string; position: number; url: string }
	| { kind: "log" }
	| { kind: "about" };

const LOG_TAB: Tab = { kind: "log" };

/** A service's page inside the hub, once it is known that the page allows it; otherwise a way to open it. */
function Frame({ hidden, url }: { hidden: boolean; url: string }) {
	const [state, setState] = useState<Framing | null>(null);
	useEffect(() => {
		let live = true;
		setState(null);
		checkFrame(url).then((result) => {
			if (live) {
				setState(result);
			}
		});
		return () => {
			live = false;
		};
	}, [url]);
	if (!state) {
		return (
			<p className="muted pad" hidden={hidden}>
				Открываю страницу…
			</p>
		);
	}
	if (!state.ok) {
		return (
			<div className="frame-note" hidden={hidden}>
				<p title={state.reason ?? undefined}>
					Этот сайт запрещает показывать себя внутри других страниц: откройте
					его в отдельной вкладке.
				</p>
				<a className="button" href={url} rel="noopener" target="_blank">
					Открыть в новой вкладке
				</a>
			</div>
		);
	}
	return <iframe className="frame" hidden={hidden} src={url} title={url} />;
}

function emptyLog(service: ServiceView): string {
	if (!service.managed && service.owner && service.status !== "busy") {
		return "Этот сервис запущен не из пульта: его вывод идёт туда, откуда его запустили. Лог появится здесь, когда сервис запустят из пульта.";
	}
	return "Лог пуст: сервис ещё не запускали из пульта.";
}

function Log({ service }: { service: ServiceView }) {
	const { clear, text } = useLog(service.key);
	const box = useRef<HTMLPreElement>(null);
	const [follow, setFollow] = useState(true);
	useLayoutEffect(() => {
		const element = box.current;
		if (follow && element && text) {
			element.scrollTop = element.scrollHeight;
		}
	}, [follow, text]);
	const toggle = useCallback(() => setFollow((value) => !value), []);
	return (
		<div className="log">
			<div className="log__bar">
				<button
					aria-pressed={follow}
					className="toggle"
					onClick={toggle}
					type="button"
				>
					Следить за концом
				</button>
				<button className="button" onClick={clear} type="button">
					Очистить экран
				</button>
			</div>
			<pre className="log__text" ref={box}>
				{text || emptyLog(service)}
			</pre>
		</div>
	);
}

function About({ service }: { service: ServiceView }) {
	const rows: [string, string][] = [
		["Команда", service.command ?? "запускается не из пульта"],
		["Папка", service.workdir],
		["Порт", service.port ? String(service.port) : "—"],
		["Проверка здоровья", service.health ?? "—"],
	];
	if (service.owner) {
		rows.push(
			["Кто держит порт", service.owner.label],
			["Его команда", service.owner.command || "—"]
		);
	}
	return (
		<div className="about">
			{service.warn ? <p className="warn">{service.warn}</p> : null}
			{service.description ? (
				<p className="muted">{service.description}</p>
			) : null}
			<dl className="facts">
				{rows.map(([term, value]) => (
					<div className="facts__row" key={term}>
						<dt>{term}</dt>
						<dd>
							<code>{value}</code>
						</dd>
					</div>
				))}
				<div className="facts__row">
					<dt>Нужно заранее</dt>
					<dd>
						{service.needs.length > 0 ? (
							<ul className="needs">
								{service.needs.map((need) => (
									<li key={need.key}>
										<span
											className={cx(
												"dot",
												need.up ? "dot--running" : "dot--stopped"
											)}
										/>
										{need.label}
										<span className="muted">
											{need.up ? " — работает" : " — не запущено"}
										</span>
									</li>
								))}
							</ul>
						) : (
							"—"
						)}
					</dd>
				</div>
			</dl>
		</div>
	);
}

function statusLine(service: ServiceView): string {
	const parts = [STATUS_WORDS[service.status]];
	if (service.managed && service.since) {
		parts.push(`${since(service.since)}`);
	}
	// A busy service's port is held by another: that one's process is in the note, not here.
	if (service.pid && service.status !== "busy") {
		parts.push(`PID ${service.pid}`);
	}
	if (service.status === "crashed" && typeof service.exit?.code === "number") {
		parts.push(`код выхода ${service.exit.code}`);
	}
	return parts.join(" · ");
}

function tabLabel(tab: Tab): string {
	if (tab.kind === "ui") {
		return tab.label;
	}
	return tab.kind === "log" ? "Лог" : "Сведения";
}

/** What the person is asked before an action, or null when nothing needs asking. */
function question(service: ServiceView, action: string): string | null {
	const foreign = !service.managed && service.owner !== null;
	const where = service.owner ? `\n${service.owner.label}` : "";
	if (action === "stop" && foreign) {
		return `${service.name} запущен не из пульта:${where}\n\nОстановить этот процесс и всё, что он запустил?`;
	}
	if (action === "restart" && foreign) {
		return `${service.name} запущен не из пульта:${where}\n\nПульт остановит его и запустит заново сам: командой «${service.command}» в ${service.workdir}. Продолжить?`;
	}
	if (action === "start" && service.warn) {
		return `${service.warn}\n\nЗапустить?`;
	}
	return null;
}

function Notes({ service }: { service: ServiceView }) {
	const waiting = service.needs.filter((need) => !need.up);
	const startable =
		service.canStart && !isUp(service.status) && service.status !== "busy";
	return (
		<>
			{service.status === "busy" && service.owner ? (
				<p className="warn pad-x">
					Порт {service.port} занят: его держит {service.owner.label}. Чтобы
					запустить этот сервис, остановите того, кто держит порт, или дайте
					этому другой порт в services.json.
				</p>
			) : null}
			{service.elsewhere ? (
				<p className="note pad-x">
					Работает из другой копии: {service.elsewhere} (в пульте записана{" "}
					{service.workdir}). «Перезапустить» запустит его из записанной.
				</p>
			) : null}
			{startable && waiting.length > 0 ? (
				<p className="note pad-x">
					Перед запуском пульт поднимет:{" "}
					{waiting.map((need) => need.label).join(", ")}.
				</p>
			) : null}
		</>
	);
}

export function ServicePage({ service }: { service: ServiceView }) {
	const tabs: Tab[] = [
		...service.ui.map((entry, position) => ({
			kind: "ui" as const,
			label: entry.label,
			position,
			url: entry.url,
		})),
		LOG_TAB,
		{ kind: "about" },
	];
	const [index, setIndex] = useState(0);
	const [opened, setOpened] = useState<number[]>([0]);
	const [reloads, setReloads] = useState<Record<number, number>>({});
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [confirm, dialog] = useConfirm();
	const up = isUp(service.status);
	// Pages show once the service answers; while it starts or is down, its log says what it is doing.
	const answering =
		service.status === "running" || service.status === "external";
	const shown = tabs[index] ?? LOG_TAB;
	const tab = shown.kind === "ui" && !answering ? LOG_TAB : shown;
	const page = tab.kind === "ui" ? tab.url : service.ui[0]?.url;

	const run = useCallback(
		async (event: MouseEvent<HTMLButtonElement>) => {
			const { action } = event.currentTarget.dataset;
			if (!action) {
				return;
			}
			const ask = question(service, action);
			if (ask && !(await confirm(ask))) {
				return;
			}
			setPending(true);
			setError(await act(`/api/services/${service.key}/${action}`));
			setPending(false);
		},
		[confirm, service]
	);
	const pick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
		const position = Number(event.currentTarget.dataset.index);
		setIndex(position);
		setOpened((current) =>
			current.includes(position) ? current : [...current, position]
		);
	}, []);
	const reload = useCallback(() => {
		setReloads((current) => ({
			...current,
			[index]: (current[index] ?? 0) + 1,
		}));
	}, [index]);

	return (
		<section aria-label={service.name} className="service">
			<header className="service__head">
				<div className="service__title">
					<span className={cx("dot", "dot--big", `dot--${service.status}`)} />
					<h1>{service.name}</h1>
					<span className="muted">{statusLine(service)}</span>
				</div>
				<div className="service__actions">
					{service.canStart && !up && service.status !== "busy" ? (
						<button
							className="button button--primary"
							data-action="start"
							disabled={pending}
							onClick={run}
							type="button"
						>
							{pending ? "Запускаю…" : "Запустить"}
						</button>
					) : null}
					{up || service.status === "unhealthy" ? (
						<button
							className="button"
							data-action="stop"
							disabled={pending}
							onClick={run}
							type="button"
						>
							Остановить
						</button>
					) : null}
					{service.canStart && (up || service.status === "unhealthy") ? (
						<button
							className="button"
							data-action="restart"
							disabled={pending}
							onClick={run}
							type="button"
						>
							Перезапустить
						</button>
					) : null}
					{tab.kind === "ui" ? (
						<button className="button" onClick={reload} type="button">
							Обновить страницу
						</button>
					) : null}
					{page ? (
						<a className="button" href={page} rel="noopener" target="_blank">
							Открыть отдельно
						</a>
					) : null}
				</div>
			</header>
			<Notes service={service} />
			{error ? <p className="error">{error}</p> : null}
			<div className="tabs" role="tablist">
				{tabs.map((entry, position) => {
					const label = tabLabel(entry);
					return (
						<button
							aria-selected={shown === entry}
							className="tabs__item"
							data-index={position}
							key={label}
							onClick={pick}
							role="tab"
							type="button"
						>
							{label}
						</button>
					);
				})}
			</div>
			<div className="service__body" role="tabpanel">
				{answering
					? service.ui.map((entry, position) =>
							opened.includes(position) ? (
								<Frame
									hidden={tab.kind !== "ui" || tab.position !== position}
									key={`${entry.url}#${reloads[position] ?? 0}`}
									url={entry.url}
								/>
							) : null
						)
					: null}
				{tab.kind === "log" ? <Log service={service} /> : null}
				{tab.kind === "about" ? <About service={service} /> : null}
			</div>
			{dialog}
		</section>
	);
}
