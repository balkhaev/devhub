import type { ComposeView, ContainerView } from "../docker";
import type { ServiceStatus } from "../hub";

/** What the page says, in plain Russian: states, times, joined class names. */

export const STATUS_WORDS: Record<ServiceStatus, string> = {
	busy: "не запущен: его порт занят другим",
	crashed: "упал",
	external: "работает (запущен не из пульта)",
	running: "работает",
	starting: "запускается",
	stopped: "остановлен",
	unhealthy: "порт занят, но не отвечает как надо",
};

export const STATUS_SHORT: Record<ServiceStatus, string> = {
	busy: "порт занят",
	crashed: "упал",
	external: "работает",
	running: "работает",
	starting: "запуск…",
	stopped: "стоит",
	unhealthy: "не отвечает",
};

export const isUp = (status: ServiceStatus): boolean =>
	status === "running" || status === "external" || status === "starting";

/** Joins class names, leaving out the ones that do not apply. */
export const cx = (...names: (string | false | null | undefined)[]): string =>
	names.filter(Boolean).join(" ");

function plural(n: number, one: string, few: string, many: string): string {
	const tens = n % 100;
	const units = n % 10;
	if (tens > 10 && tens < 20) {
		return many;
	}
	if (units === 1) {
		return one;
	}
	return units >= 2 && units <= 4 ? few : many;
}

/** «3 мин», «2 ч 5 мин», «4 дн» since a moment. */
export function since(at: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.floor((now - at) / 60_000));
	if (minutes < 1) {
		return "меньше минуты";
	}
	if (minutes < 60) {
		return `${minutes} ${plural(minutes, "минута", "минуты", "минут")}`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return `${hours} ч ${minutes % 60} мин`;
	}
	const days = Math.floor(hours / 24);
	return `${days} ${plural(days, "день", "дня", "дней")}`;
}

export const servicesWord = (n: number): string =>
	`${n} ${plural(n, "сервис", "сервиса", "сервисов")}`;

/** A container's state as a status dot: a one-off job that finished well is not a failure. */
export function containerStatus(container: ContainerView): string {
	if (!container.running) {
		return container.exitCode === 0 ? "done" : "stopped";
	}
	if (container.health === "unhealthy") {
		return "unhealthy";
	}
	return container.health === "starting" ? "starting" : "running";
}

/** A compose project's state as a status dot. */
export function composeStatus(project: ComposeView): string {
	if (project.ready) {
		return "running";
	}
	const running = project.containers.filter((container) => container.running);
	if (running.some((container) => container.health === "starting")) {
		return "starting";
	}
	return running.length > 0 ? "unhealthy" : "stopped";
}

/** A compose project's state in words; nothing can be said of it while Docker itself is not running. */
export function composeWords(project: ComposeView, dockerUp = true): string {
	if (!dockerUp) {
		return "Docker не запущен";
	}
	const running = project.containers.filter(
		(container) => container.running
	).length;
	if (project.containers.length === 0) {
		return "ещё не создан";
	}
	if (project.ready) {
		return `работает (${running} из ${project.containers.length})`;
	}
	return running > 0
		? `работает не всё (${running} из ${project.containers.length})`
		: "остановлен";
}
