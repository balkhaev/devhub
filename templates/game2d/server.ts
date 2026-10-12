import { join } from "node:path";
import { createHandler, readServerOptions } from "./server/handler";

const { hostname, port } = readServerOptions(process.env);
const server = Bun.serve({
  hostname,
  port,
  fetch: createHandler(join(import.meta.dir, "dist")),
});

console.log(`Production game listening on http://${server.hostname}:${server.port}`);
