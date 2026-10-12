import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler, readServerOptions } from "../server/handler";

let directory: string;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "game2d-server-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Game</title>");
  await writeFile(join(directory, "assets", "game-a1b2.js"), "export const ready = true;");
  handler = createHandler(directory);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("standalone production serving", () => {
  test("HTML is uncached and hashed assets immutable with security headers", async () => {
    const html = await handler(new Request("http://localhost/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const asset = await handler(new Request("http://localhost/assets/game-a1b2.js"));
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toContain("ready");
  });

  test("HEAD has the same metadata and no body", async () => {
    const response = await handler(new Request("http://localhost/", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await response.text()).toBe("");
  });

  test("SPA routes require HTML accept; missing scripts never return HTML", async () => {
    expect((await handler(new Request("http://localhost/workshop", { headers: { accept: "text/html" } }))).status).toBe(200);
    expect((await handler(new Request("http://localhost/workshop"))).status).toBe(404);
    expect((await handler(new Request("http://localhost/missing.js", { headers: { accept: "text/html" } }))).status).toBe(404);
  });

  test("encoded traversal, malformed URL and writes are rejected", async () => {
    for (const path of ["/%2e%2e%2fpackage.json", "/%5c..%5cpackage.json", "/%00", "/%zz"]) {
      expect((await handler(new Request(`http://localhost${path}`))).status).toBe(400);
    }
    expect((await handler(new Request("http://localhost/", { method: "POST" }))).status).toBe(405);
  });

  test("health is available independently from DevHub", async () => {
    const response = await handler(new Request("http://localhost/health"));
    expect(await response.json()).toEqual({ ok: true });
  });

  test("only HOST and PORT configure production; invalid ports fail fast", () => {
    expect(readServerOptions({ NODE_ENV: "production", DEVHUB_PORT: "9999" })).toEqual({ hostname: "0.0.0.0", port: 3000 });
    expect(readServerOptions({ HOST: "127.0.0.1", PORT: "3050" })).toEqual({ hostname: "127.0.0.1", port: 3050 });
    for (const port of ["", "0", "65536", "3000.5", "text"]) {
      expect(() => readServerOptions({ PORT: port })).toThrow();
    }
    expect(() => readServerOptions({ HOST: "http://localhost" })).toThrow();
  });
});
