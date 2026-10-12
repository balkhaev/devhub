import { extname, resolve, sep } from "node:path";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

export function readServerOptions(env: Record<string, string | undefined>): {
  hostname: string;
  port: number;
} {
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const hostname = env.HOST ?? "0.0.0.0";
  if (!hostname || /[\s/\\?#:@]/.test(hostname)) {
    throw new Error("HOST must be a hostname or an IPv4 address");
  }
  return { hostname, port };
}

function reply(body: BodyInit | null, status: number, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/** A standalone production handler. Only built files are public; no DevHub imports or env. */
export function createHandler(directory: string): (request: Request) => Promise<Response> {
  const root = resolve(directory);
  return async (request) => {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      return reply("Method not allowed", 405, { Allow: "GET, HEAD" });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return reply(head ? null : "Bad request", 400);
    }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes("..")) {
      return reply(head ? null : "Bad request", 400);
    }
    if (pathname === "/health") {
      return reply(head ? null : '{"ok":true}', 200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
    }
    const target = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(`${root}${sep}`)) {
      return reply(head ? null : "Not found", 404);
    }
    let file = Bun.file(target);
    let html = extname(target) === ".html";
    if (!(await file.exists())) {
      if (!extname(pathname) && request.headers.get("accept")?.includes("text/html")) {
        file = Bun.file(resolve(root, "index.html"));
        html = true;
      } else {
        return reply(head ? null : "Not found", 404);
      }
    }
    if (!(await file.exists())) {
      return reply(head ? null : "Build the game before starting production", 503);
    }
    const cache = html ? "no-store" : pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    return reply(head ? null : file, 200, {
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(file.size),
      "Cache-Control": cache,
    });
  };
}
