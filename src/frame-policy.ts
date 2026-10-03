const ASCII_WHITESPACE = /[\t\n\f\r ]+/;
const NON_ASCII = /[^\p{ASCII}]/u;
const SCHEME_SOURCE = /^([a-z][a-z0-9+.-]*):$/i;
const HOST_SOURCE =
	/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|[0-9]+))?(\/[^?#]*)?$/i;

export interface Framing {
	ok: boolean;
	/** The response header that forbids embedding, when one does. */
	reason: string | null;
	/** Unsupported policies are left to the browser rather than blocking a usable frame. */
	sure: boolean;
}

type Match = boolean | null;
const uncertain = (): Framing => ({ ok: true, reason: null, sure: false });
const allowed = (): Framing => ({ ok: true, reason: null, sure: true });
const blocked = (reason: string): Framing => ({
	ok: false,
	reason,
	sure: true,
});

function httpOrigin(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? new URL(url.origin)
			: null;
	} catch {
		return null;
	}
}

function schemeMatches(source: string, protocol: string): boolean {
	const target = protocol.slice(0, -1);
	return (
		source === target ||
		(source === "http" && target === "https") ||
		(source === "ws" && ["wss", "http", "https"].includes(target)) ||
		(source === "wss" && target === "https")
	);
}

function selfMatches(parent: URL, resource: URL): boolean {
	return (
		parent.origin === resource.origin ||
		(parent.hostname === resource.hostname &&
			parent.port === resource.port &&
			parent.protocol === "https:")
	);
}

function portMatches(
	port: string | undefined,
	parent: URL,
	scheme: string
): Match {
	if (port === "*") {
		return true;
	}
	const parentPort = Number(
		parent.port || (parent.protocol === "https:" ? 443 : 80)
	);
	if (port === undefined ? !parent.port : Number(port) === parentPort) {
		return true;
	}
	// Secure upgrades involving an explicit default port vary across implementations.
	if (scheme === "http" && parent.protocol === "https:" && port === "80") {
		return null;
	}
	return false;
}

function hostSourceMatches(value: string, parent: URL, resource: URL): Match {
	const hostSource = HOST_SOURCE.exec(value);
	if (!hostSource) {
		return null;
	}
	const [, explicitScheme, host, port, path] = hostSource;
	const scheme = explicitScheme ?? resource.protocol.slice(0, -1);
	if (!schemeMatches(scheme, parent.protocol)) {
		return false;
	}
	const hostMatches =
		host === "*" ||
		host === parent.hostname ||
		(host?.startsWith("*.") && parent.hostname.endsWith(host.slice(1)));
	if (!hostMatches) {
		return false;
	}
	const ports = portMatches(port, parent, scheme);
	if (ports !== true) {
		return ports;
	}
	// Ancestors are origins, not the requested document path. Leave exotic path expressions to the browser.
	return path && path !== "/" ? null : true;
}

function sourceMatches(source: string, parent: URL, resource: URL): Match {
	const value = source.toLowerCase();
	if (value === "'none'") {
		return false;
	}
	if (value === "'self'") {
		return selfMatches(parent, resource);
	}
	if (value === "*") {
		return true;
	}
	const schemeSource = SCHEME_SOURCE.exec(value);
	return schemeSource?.[1]
		? schemeMatches(schemeSource[1], parent.protocol)
		: hostSourceMatches(value, parent, resource);
}

function ancestorsMatch(
	sources: readonly string[],
	parent: URL,
	resource: URL
): Match {
	let unknown = false;
	for (const source of sources) {
		const match = sourceMatches(source, parent, resource);
		if (match === true) {
			return true;
		}
		unknown ||= match === null;
	}
	return unknown ? null : false;
}

/** A comma separates policies; the first occurrence of a directive within each policy wins. */
function ancestorLists(policy: string): string[][] {
	const lists: string[][] = [];
	for (const entry of policy.split(",")) {
		for (const directive of entry.split(";")) {
			if (NON_ASCII.test(directive)) {
				continue;
			}
			const [name, ...values] = directive
				.split(ASCII_WHITESPACE)
				.filter(Boolean);
			if (name?.toLowerCase() === "frame-ancestors") {
				lists.push(values);
				break;
			}
		}
	}
	return lists;
}

function cspFramePolicy(
	lists: string[][],
	parent: URL | null,
	resource: URL | null
): Framing {
	if (!(parent && resource)) {
		return uncertain();
	}
	const matches = lists.map((sources) => ({
		match: ancestorsMatch(sources, parent, resource),
		sources,
	}));
	const rejected = matches.find((entry) => entry.match === false);
	if (rejected) {
		return blocked(`frame-ancestors ${rejected.sources.join(" ")}`.trimEnd());
	}
	return matches.some((entry) => entry.match === null)
		? uncertain()
		: allowed();
}

function xfoFramePolicy(
	options: string,
	parent: URL | null,
	resource: URL | null
): Framing {
	const values = new Set(
		options
			.toLowerCase()
			.split(",")
			.map((v) => v.trim())
	);
	if (
		values.has("deny") ||
		(values.size > 1 && (values.has("sameorigin") || values.has("allowall")))
	) {
		return blocked(`X-Frame-Options: ${options}`);
	}
	if (values.has("sameorigin")) {
		if (!(parent && resource)) {
			return uncertain();
		}
		return parent.origin === resource.origin
			? allowed()
			: blocked(`X-Frame-Options: ${options}`);
	}
	return uncertain();
}

/**
 * Evaluate response policies for DevHub's direct child frame, without rewriting any security header.
 * CSP: https://www.w3.org/TR/CSP3/#frame-ancestors
 * XFO: https://html.spec.whatwg.org/multipage/speculative-loading.html#the-x-frame-options-header
 */
export function framePolicy(
	headers: Headers,
	resourceUrl: string,
	parentOrigin: string
): Framing {
	const lists = ancestorLists(headers.get("content-security-policy") ?? "");
	const parent = httpOrigin(parentOrigin);
	const resource = httpOrigin(resourceUrl);
	// Any enforced frame-ancestors directive takes precedence over X-Frame-Options.
	if (lists.length > 0) {
		return cspFramePolicy(lists, parent, resource);
	}
	const options = headers.get("x-frame-options");
	return options ? xfoFramePolicy(options, parent, resource) : allowed();
}
