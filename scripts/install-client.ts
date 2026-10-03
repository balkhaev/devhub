import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const file = join(homedir(), ".devhub.json");
const settings = existsSync(file)
	? (JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>)
	: {};
await writeFile(
	file,
	`${JSON.stringify({ ...settings, root: resolve(import.meta.dir, "..") }, null, 2)}\n`
);
process.stdout.write(`Dev-команды используют ${file}\n`);
