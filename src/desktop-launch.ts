import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessInfo } from "./probes";

export const DESKTOP_LAUNCH_MS = 20_000;
const ARGUMENT = /"([^"]+)"|([^\s"]+)/g;
const MARKER = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TICKS = /^\d+$/;
export const isLaunchMarker = (value: string): boolean => MARKER.test(value);

export interface LauncherIdentity {
	batch: string;
	created: string;
	marker: string;
}

export function isLauncherIdentity(value: unknown): value is LauncherIdentity {
	if (!value || typeof value !== "object") {
		return false;
	}
	const identity = value as Partial<LauncherIdentity>;
	return (
		typeof identity.batch === "string" &&
		identity.batch.length > 0 &&
		typeof identity.created === "string" &&
		TICKS.test(identity.created) &&
		typeof identity.marker === "string" &&
		isLaunchMarker(identity.marker)
	);
}

export interface LaunchIntent {
	batch: string;
	marker: string;
	requestedAt: number;
	state: "pending" | "approved" | "cancelled";
}

export interface LaunchReceipt extends LauncherIdentity {
	command: string;
	parent: number;
	pid: number;
}

export interface LaunchFiles {
	approval: string;
	intent: string;
	receipt: string;
}

export const launchFiles = (
	directory: string,
	key: string,
	marker: string
): LaunchFiles => ({
	approval: join(directory, `${key.replace("/", "-")}-${marker}.approved`),
	intent: join(directory, `${key.replace("/", "-")}.json`),
	receipt: join(directory, `${key.replace("/", "-")}-${marker}.receipt.json`),
});

export function hasArgument(command: string, value: string): boolean {
	return [...command.matchAll(ARGUMENT)].some(
		(match) => (match[1] ?? match[2]) === value
	);
}

export function namesBatch(command: string, batch: string): boolean {
	const normalize = (value: string) =>
		value.replaceAll("/", "\\").toLowerCase();
	return [...command.matchAll(ARGUMENT)].some(
		(match) => normalize(match[1] ?? match[2] ?? "") === normalize(batch)
	);
}

/** Numeric PID and parent PID alone never establish ownership. */
export function matchesLauncher(
	info: ProcessInfo | undefined,
	identity: LauncherIdentity
): boolean {
	return Boolean(
		isLauncherIdentity(identity) &&
			info &&
			info.name.toLowerCase() === "cmd.exe" &&
			info.created === identity.created &&
			namesBatch(info.command, identity.batch) &&
			hasArgument(info.command, identity.marker)
	);
}

export async function readIntent(path: string): Promise<LaunchIntent | null> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as LaunchIntent;
		if (
			MARKER.test(value.marker) &&
			typeof value.batch === "string" &&
			Number.isFinite(value.requestedAt) &&
			["pending", "approved", "cancelled"].includes(value.state)
		) {
			return value;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	throw new Error("Invalid desktop launch intent; refusing a second launch");
}

export async function saveIntent(
	path: string,
	intent: LaunchIntent
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(intent));
	await rename(temporary, path);
}

export async function readReceipt(
	path: string,
	intent: LaunchIntent
): Promise<LaunchReceipt | null> {
	try {
		const receipt = JSON.parse(await readFile(path, "utf8")) as LaunchReceipt;
		if (
			receipt.marker === intent.marker &&
			receipt.batch === intent.batch &&
			Number.isInteger(receipt.pid) &&
			receipt.pid > 0 &&
			Number.isInteger(receipt.parent) &&
			typeof receipt.created === "string" &&
			TICKS.test(receipt.created) &&
			typeof receipt.command === "string" &&
			namesBatch(receipt.command, intent.batch) &&
			hasArgument(receipt.command, intent.marker)
		) {
			return receipt;
		}
	} catch {
		// The receipt is written atomically; while absent, the batch cannot run its service yet.
	}
	return null;
}

export async function cancelLaunch(
	files: LaunchFiles,
	intent: LaunchIntent
): Promise<void> {
	await saveIntent(files.intent, { ...intent, state: "cancelled" });
	await rm(files.approval, { force: true });
}

export async function awaitReceipt(
	files: LaunchFiles,
	intent: LaunchIntent,
	timeoutMs = DESKTOP_LAUNCH_MS,
	cancelled = () => false
): Promise<LaunchReceipt> {
	const deadline = intent.requestedAt + timeoutMs;
	while (Date.now() <= deadline) {
		if (cancelled()) {
			break;
		}
		// biome-ignore lint/performance/noAwaitInLoops: each read waits for the desktop-owned batch's durable receipt
		const receipt = await readReceipt(files.receipt, intent);
		if (receipt) {
			return receipt;
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	await cancelLaunch(files, intent);
	throw new Error(
		"Desktop launcher did not identify itself; its service was not approved to start"
	);
}

export async function approveLaunch(
	files: LaunchFiles,
	intent: LaunchIntent,
	wanted: () => void = () => undefined
): Promise<void> {
	await saveIntent(files.intent, { ...intent, state: "approved" });
	wanted();
	// No await between the final cancellation check and permission commit. A stop cannot be overtaken by a late write.
	const temporary = `${files.approval}.tmp`;
	writeFileSync(temporary, intent.marker);
	renameSync(temporary, files.approval);
}
