import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";

import { type Framing, framePolicy } from "../src/frame-policy";
import { frameable } from "../src/probes";
import { startHub } from "../src/server";

const RESOURCE = "http://127.0.0.1:8765/app/";
const PARENT = "http://127.0.0.1:4700";
const ALLOWED = { ok: true, reason: null, sure: true };
const UNCERTAIN = { ok: true, reason: null, sure: false };

function policy(
	value: string,
	parent = PARENT,
	resource = RESOURCE,
	other: Record<string, string> = {}
): Framing {
	return framePolicy(
		new Headers({ "content-security-policy": value, ...other }),
		resource,
		parent
	);
}

function expectBlocked(result: Framing): void {
	expect(result.ok).toBe(false);
	expect(result.sure).toBe(true);
	expect(result.reason).not.toBeNull();
}

test("an exact ancestor permits only its hostname, scheme and port", () => {
	expect(policy(`frame-ancestors ${PARENT}`)).toEqual(ALLOWED);
	for (const source of [
		"http://127.0.0.1:4701",
		"http://localhost:4700",
		"https://127.0.0.1:4700",
		"http://127.0.0.1",
	]) {
		expectBlocked(policy(`frame-ancestors ${source}`));
	}
});

test("self refers to the protected response's origin, not its document path", () => {
	expect(policy("frame-ancestors 'self'", "http://127.0.0.1:8765")).toEqual(
		ALLOWED
	);
	expectBlocked(policy("frame-ancestors 'self'"));
	expectBlocked(policy("frame-ancestors 'self'", "http://localhost:8765"));
	expect(
		policy(
			"frame-ancestors 'self'",
			"https://example.com",
			"http://example.com"
		)
	).toEqual(ALLOWED);
});

test("wildcards respect domain boundaries and port restrictions", () => {
	const source = "frame-ancestors https://*.example.com:443";
	expect(policy(source, "https://preview.example.com")).toEqual(ALLOWED);
	for (const parent of [
		"https://example.com",
		"https://notexample.com",
		"https://example.com.attacker.test",
		"https://preview.example.com:444",
		"http://preview.example.com",
	]) {
		expectBlocked(policy(source, parent));
	}
	expect(policy("frame-ancestors http://127.0.0.1:*")).toEqual(ALLOWED);
	expectBlocked(policy("frame-ancestors http://localhost:*"));
});

test("scheme sources and schemeless hosts follow the protected origin's scheme", () => {
	expect(policy("frame-ancestors http:")).toEqual(ALLOWED);
	expect(policy("frame-ancestors http:", "https://example.com")).toEqual(
		ALLOWED
	);
	expectBlocked(policy("frame-ancestors https:"));
	expect(policy("frame-ancestors 127.0.0.1:4700")).toEqual(ALLOWED);
	expectBlocked(
		policy("frame-ancestors 127.0.0.1:4700", PARENT, "https://example.com")
	);
});

test("enforced ancestors take priority over XFO but report-only does not", () => {
	expect(
		policy(`frame-ancestors ${PARENT}`, PARENT, RESOURCE, {
			"x-frame-options": "DENY",
		})
	).toEqual(ALLOWED);
	expectBlocked(
		policy("frame-ancestors 'none'", PARENT, RESOURCE, {
			"x-frame-options": "ALLOWALL",
		})
	);
	expect(
		framePolicy(
			new Headers({
				"content-security-policy-report-only": "frame-ancestors 'none'",
			}),
			RESOURCE,
			PARENT
		)
	).toEqual(ALLOWED);
	expectBlocked(
		framePolicy(
			new Headers({
				"content-security-policy-report-only": `frame-ancestors ${PARENT}`,
				"x-frame-options": "DENY",
			}),
			RESOURCE,
			PARENT
		)
	);
});

test("every policy must permit the parent and the first duplicate directive wins", () => {
	const headers = new Headers();
	headers.append("content-security-policy", `frame-ancestors ${PARENT}`);
	headers.append("content-security-policy", "frame-ancestors 'none'");
	expectBlocked(framePolicy(headers, RESOURCE, PARENT));
	expect(policy(`frame-ancestors ${PARENT}, frame-ancestors *`)).toEqual(
		ALLOWED
	);
	expectBlocked(policy("frame-ancestors 'none'; frame-ancestors *"));
	expect(policy("FRAME-ANCESTORS *; frame-ancestors 'none'")).toEqual(ALLOWED);
	expectBlocked(policy("frame-ancestors; frame-ancestors *"));
	expect(policy(`frame-ancestors 'none' ${PARENT}`)).toEqual(ALLOWED);
});

test("unrelated CSP directives do not restrict ancestors or override XFO", () => {
	expect(policy("default-src 'none'; frame-src 'none'")).toEqual(ALLOWED);
	expectBlocked(
		policy("default-src *", PARENT, RESOURCE, { "x-frame-options": "DENY" })
	);
	expectBlocked(policy("frame-ancestors 'none'; img-src *"));
});

test("SAMEORIGIN accepts the same origin and rejects host aliases or different ports", () => {
	const headers = new Headers({ "x-frame-options": "SameOrigin" });
	expect(framePolicy(headers, RESOURCE, "http://127.0.0.1:8765")).toEqual(
		ALLOWED
	);
	expectBlocked(framePolicy(headers, RESOURCE, PARENT));
	expectBlocked(framePolicy(headers, RESOURCE, "http://localhost:8765"));
	expect(
		framePolicy(headers, "http://example.com:80/page", "http://example.com")
	).toEqual(ALLOWED);
	for (const options of ["DENY", "SAMEORIGIN, DENY", "ALLOWALL, invalid"]) {
		expectBlocked(
			framePolicy(new Headers({ "x-frame-options": options }), RESOURCE, PARENT)
		);
	}
});

test("unsupported policies are uncertain while a separate known block remains decisive", () => {
	for (const value of [
		"frame-ancestors http://[::1]:4700",
		"frame-ancestors http://127.0.0.1:4700/embedded/",
		"frame-ancestors 'unsupported'",
	]) {
		expect(policy(value)).toEqual(UNCERTAIN);
	}
	expect(
		policy("frame-ancestors 'unsupported'", PARENT, RESOURCE, {
			"x-frame-options": "DENY",
		})
	).toEqual(UNCERTAIN);
	expectBlocked(
		policy("frame-ancestors 'unsupported', frame-ancestors 'none'")
	);
	expect(policy("frame-ancestors 'unsupported' *")).toEqual(ALLOWED);
	expect(policy("frame-ancestors *", "null")).toEqual(UNCERTAIN);
});

test("the HTTP probe uses final redirect headers and final self origin", async () => {
	const target = serve({
		fetch: (request) =>
			new Response("target", {
				headers:
					new URL(request.url).pathname === "/sameorigin"
						? { "x-frame-options": "SAMEORIGIN" }
						: { "content-security-policy": "frame-ancestors 'self'" },
			}),
		hostname: "127.0.0.1",
		port: 0,
	});
	const finalOrigin = `http://127.0.0.1:${target.port}`;
	const redirect = serve({
		fetch: (request) =>
			new Response(null, {
				headers: {
					"content-security-policy": "frame-ancestors 'none'",
					location: `${finalOrigin}${new URL(request.url).pathname}`,
				},
				status: 302,
			}),
		hostname: "127.0.0.1",
		port: 0,
	});
	const firstOrigin = `http://127.0.0.1:${redirect.port}`;
	try {
		await Promise.all(
			["/self", "/sameorigin"].map(async (path) => {
				expect(await frameable(firstOrigin + path, finalOrigin)).toEqual(
					ALLOWED
				);
				expectBlocked(await frameable(firstOrigin + path, firstOrigin));
			})
		);
	} finally {
		redirect.stop(true);
		target.stop(true);
	}
});

test("the frame API compares explicit policies against the request's actual DevHub origin", async () => {
	const root = await mkdtemp(join(tmpdir(), "devhub-frame-api-"));
	await writeFile(
		join(root, "services.json"),
		JSON.stringify({ code: root, projects: [] })
	);
	const instance = await startHub({
		port: 0,
		root,
		runtime: {
			dockerView: async () => ({ available: false, projects: [] }),
			listeningPorts: async () => new Map(),
			listeningPortsV6: async () => new Map(),
		},
	});
	const parent = new URL(instance.url);
	const localParent = new URL(parent);
	localParent.hostname = "localhost";
	const target = serve({
		fetch: (request) =>
			new Response("fixture", {
				headers: {
					"content-security-policy": `frame-ancestors ${new URL(request.url).pathname === "/localhost" ? localParent.origin : parent.origin}`,
					"x-frame-options": "DENY",
				},
			}),
		hostname: "127.0.0.1",
		port: 0,
	});
	const probe = async (base: URL, path: string, headers = {}) => {
		const url = new URL("/api/frame", base);
		url.searchParams.set("url", `http://127.0.0.1:${target.port}${path}`);
		return (await (await fetch(url, { headers })).json()) as Framing;
	};
	try {
		expect(await probe(parent, "/exact")).toEqual(ALLOWED);
		expectBlocked(
			await probe(parent, "/localhost", { origin: localParent.origin })
		);
		expect(await probe(localParent, "/localhost")).toEqual(ALLOWED);
		expectBlocked(await probe(localParent, "/exact"));
		const response = await fetch(`http://127.0.0.1:${target.port}/exact`);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toBe(
			`frame-ancestors ${parent.origin}`
		);
	} finally {
		target.stop(true);
		instance.stop();
		await rm(root, { force: true, recursive: true });
	}
});

test("a page that cannot answer is left to the browser", async () => {
	const fixture = serve({
		fetch: () => new Response("fixture"),
		hostname: "127.0.0.1",
		port: 0,
	});
	const url = `http://127.0.0.1:${fixture.port}`;
	fixture.stop(true);
	expect(await frameable(url, PARENT)).toEqual(UNCERTAIN);
});
