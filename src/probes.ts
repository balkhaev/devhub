import { spawn } from "node:child_process";

import { type Framing, framePolicy } from "./frame-policy";

export type { Framing } from "./frame-policy";

/**
 * What runs on this computer, whoever started it: the ports that listen and the processes behind them (with their
 * command lines and parents, which tell which checkout a server runs from), whether a port answers and whether a
 * health page says the service is ready.
 */

const LINE_BREAK = /\r?\n/;
const SPACES = /\s+/;
const HEALTH_MS = 2000;
const FRAME_MS = 4000;

export interface Ran {
	/** The exit code; null when the program could not start or ran out of time. */
	code: number | null;
	err: string;
	out: string;
}

/** Runs a program and returns its exit code and what it printed. */
export function run(
	command: string,
	args: readonly string[],
	timeoutMs = 10_000
): Promise<Ran> {
	return new Promise((done) => {
		const child = spawn(command, args, { windowsHide: true });
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			err += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ code: null, err: error.message, out });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, err, out });
		});
	});
}

/** Runs a program and returns what it printed; failures give an empty string. */
export async function capture(
	command: string,
	args: readonly string[],
	timeoutMs = 10_000
): Promise<string> {
	return (await run(command, args, timeoutMs)).out;
}

/** `netstat -ano` in, the listening TCP ports and the processes that own them out. */
export function parseNetstat(text: string): Map<number, number> {
	const ports = new Map<number, number>();
	for (const line of text.split(LINE_BREAK)) {
		const parts = line.trim().split(SPACES);
		if (parts[0] !== "TCP" || parts[3] !== "LISTENING") {
			continue;
		}
		const address = parts[1] ?? "";
		const port = Number(address.slice(address.lastIndexOf(":") + 1));
		const pid = Number(parts[4]);
		if (port > 0 && pid > 0 && !ports.has(port)) {
			ports.set(port, pid);
		}
	}
	return ports;
}

export async function listeningPorts(): Promise<Map<number, number>> {
	return parseNetstat(await capture("netstat", ["-ano", "-p", "TCP"]));
}

export async function listeningPortsV6(): Promise<Map<number, number>> {
	return parseNetstat(await capture("netstat", ["-ano", "-p", "TCPv6"]));
}

export interface ProcessInfo {
	command: string;
	name: string;
	parent: number;
	pid: number;
}

/** Command lines and parents of processes, through one PowerShell call. */
export async function processInfo(
	pids: readonly number[]
): Promise<Map<number, ProcessInfo>> {
	const found = new Map<number, ProcessInfo>();
	const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
	if (ids.length === 0) {
		return found;
	}
	const filter = ids.map((pid) => `ProcessId=${pid}`).join(" or ");
	const script = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
	const text = await capture("powershell", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		script,
	]);
	if (!text.trim()) {
		return found;
	}
	try {
		const value = JSON.parse(text) as
			| Record<string, unknown>
			| Record<string, unknown>[];
		for (const entry of Array.isArray(value) ? value : [value]) {
			const pid = Number(entry.ProcessId);
			found.set(pid, {
				command: String(entry.CommandLine ?? ""),
				name: String(entry.Name ?? ""),
				parent: Number(entry.ParentProcessId ?? 0),
				pid,
			});
		}
	} catch {
		// PowerShell said something that is not JSON: the processes stay unnamed.
	}
	return found;
}

/** A health page answers 2xx (or a redirect) in time. */
export async function healthy(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(HEALTH_MS),
		});
		await response.body?.cancel();
		return response.status < 400;
	} catch {
		return false;
	}
}

/** Whether a page lets itself be shown inside another page (X-Frame-Options, CSP frame-ancestors). */
export async function frameable(
	url: string,
	parentOrigin: string
): Promise<Framing> {
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(FRAME_MS) });
		await response.body?.cancel();
	} catch {
		return { ok: true, reason: null, sure: false };
	}
	return framePolicy(response.headers, response.url || url, parentOrigin);
}
