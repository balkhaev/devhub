import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
	missingInterfaces,
	projectInterfaces,
} from "../scripts/project-interfaces";
import { StageProject } from "../src/stage";

function removeFixture(base: string): void {
	const absolute = resolve(base);
	if (
		dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() ||
		!basename(absolute).startsWith("devhub-interfaces-test-")
	) {
		throw new Error(`Refuse cleanup outside disposable fixture: ${absolute}`);
	}
	rmSync(absolute, { force: true, recursive: true });
}

test("interface migration fills only audited missing metadata and is idempotent", () => {
	const contract = {
		id: "hub",
		services: [
			{
				command: "next dev",
				health: "/custom-health",
				id: "web",
				ui: [{ label: "Custom frontend", url: "https://custom.example/app" }],
			},
			{ id: "server", ui: [{ label: "API", url: "/docs" }] },
		],
	};
	const unchanged = structuredClone(contract);
	expect(missingInterfaces(contract)).toEqual([]);
	expect(contract).toEqual(unchanged);
	const missing = {
		id: "hub",
		services: [{ command: "next dev", id: "web" }, { id: "server" }],
	};
	expect(missingInterfaces(missing)).toEqual([
		{ health: "/api/health", service: "web", ui: [{ label: "Hub", url: "/" }] },
	]);
	expect(missing.services[1]).toEqual({ id: "server" });
	expect(missingInterfaces(missing)).toEqual([]);
	expect(
		missingInterfaces({
			id: "harness",
			services: [{ id: "desktop" }, { id: "server" }],
		})
	).toEqual([]);
});

test("interface writes share stage locks and retain the original before changing a contract", async () => {
	const base = mkdtempSync(join(tmpdir(), "devhub-interfaces-test-"));
	const hub = join(base, "hub");
	const project = join(base, "project");
	try {
		for (const root of [hub, project]) {
			mkdirSync(join(root, ".devhub"), { recursive: true });
			const git = spawnSync(
				"git",
				["-C", root, "init", "--initial-branch=stage"],
				{ encoding: "utf8", windowsHide: true }
			);
			if (git.status !== 0) {
				throw new Error(git.stderr || "Fixture Git initialization failed");
			}
			writeFileSync(
				join(root, ".devhub", "worktree.json"),
				JSON.stringify({
					checks: ["node --version"],
					releaseBranch: "main",
					stageBranch: "stage",
					version: 1,
					worktreeRoot: "../.worktrees/project",
				})
			);
		}
		const file = join(project, "devhub.json");
		const original = JSON.stringify({
			id: "analytics",
			name: "Analytics fixture",
			services: [{ command: "next dev", id: "web", name: "web", port: 3456 }],
		});
		writeFileSync(file, original);
		mkdirSync(join(project, "apps/web/src/app"), { recursive: true });
		writeFileSync(
			join(project, "apps/web/src/app/page.tsx"),
			"export default function Page() {}\n"
		);
		const catalogue = join(hub, "services.json");
		writeFileSync(
			catalogue,
			JSON.stringify({ discover: [base], projects: [] })
		);
		const options = { catalogue, hub };
		expect((await projectInterfaces(options)).changes).toBe(1);
		expect(readFileSync(file, "utf8")).toBe(original);
		const state = join(hub, ".state/stage");
		const held = new StageProject(project, state);
		const release = held.acquireLock();
		try {
			await expect(
				projectInterfaces({ ...options, write: true })
			).rejects.toThrow("stage-процессом");
			expect(readFileSync(file, "utf8")).toBe(original);
			expect(existsSync(new StageProject(hub, state).lockFile)).toBe(false);
		} finally {
			release();
		}
		const written = await projectInterfaces({ ...options, write: true });
		const [change] = written.projects;
		if (!change) {
			throw new Error("Missing fixture interface proposal");
		}
		expect(
			readFileSync(
				join(
					hub,
					".state/migrations/project-management-20261003/interfaces/analytics",
					change.beforeHash,
					"devhub.json"
				),
				"utf8"
			)
		).toBe(original);
		expect(JSON.parse(readFileSync(file, "utf8")).services[0].ui).toEqual([
			{ label: "Приложение", url: "/" },
		]);
		expect((await projectInterfaces(options)).changes).toBe(0);
		expect(existsSync(held.lockFile)).toBe(false);
	} finally {
		removeFixture(base);
	}
});
