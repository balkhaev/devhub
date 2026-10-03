import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { primaryCheckout, sameSourcePath } from "../src/checkouts";
import { loadCatalogue, type ProjectConfig } from "../src/config";
import { StageProject } from "../src/stage";

interface Interface {
	evidence: { file: string; includes: string };
	health?: string;
	label: string;
	project: string;
	service: string;
}

/** Each root page was checked in its canonical source; API and desktop services are intentionally absent. */
export const VERIFIED_INTERFACES: readonly Interface[] = [
	{
		evidence: { file: "apps/web/src/app/page.tsx", includes: "export default" },
		label: "Приложение",
		project: "analytics",
		service: "web",
	},
	{
		evidence: { file: "apps/web/src/app/page.tsx", includes: "export default" },
		label: "Приложение",
		project: "balkhaev",
		service: "web",
	},
	{
		evidence: { file: "scripts/serve.ts", includes: '["/", "index.html"]' },
		label: "Сайт",
		project: "balkhaev-com",
		service: "site",
	},
	{
		evidence: { file: "apps/web/src/app/page.tsx", includes: "export default" },
		label: "Приложение",
		project: "brains",
		service: "web",
	},
	{
		evidence: {
			file: "apps/web/src/app/page.tsx",
			includes: 'redirect("/chat")',
		},
		health: "/api/health",
		label: "Hub",
		project: "hub",
		service: "web",
	},
	{
		evidence: {
			file: "apps/web/src/app/(console)/page.tsx",
			includes: "export default",
		},
		label: "Консоль",
		project: "modeler",
		service: "web",
	},
	{
		evidence: { file: "apps/web/src/app/page.tsx", includes: "export default" },
		label: "Montage",
		project: "montage",
		service: "web",
	},
	{
		evidence: { file: "apps/studio/src/server.ts", includes: '"/": page' },
		label: "Студия",
		project: "montage",
		service: "studio-local",
	},
	{
		evidence: {
			file: "apps/web/src/app/(admin)/page.tsx",
			includes: "export default",
		},
		label: "Персоны",
		project: "persons",
		service: "web",
	},
	{
		evidence: {
			file: "predict/api.py",
			includes: 'app.mount("/", StaticFiles(directory=ROOT / "web", html=True)',
		},
		label: "Прогнозы",
		project: "predict",
		service: "runtime",
	},
	{
		evidence: {
			file: "apps/web-ember/src/app/(marketing)/page.tsx",
			includes: "export default",
		},
		label: "Сайт Ember",
		project: "luvclub",
		service: "web-ember",
	},
	{
		evidence: {
			file: "apps/web-ember/src/app/(marketing)/page.tsx",
			includes: "export default",
		},
		label: "Сайт Ember",
		project: "luvclub",
		service: "web-ember-dev-turbo",
	},
	{
		evidence: {
			file: "apps/web-neon/src/app/(marketing)/page.tsx",
			includes: "export default",
		},
		label: "Сайт Neon",
		project: "luvclub",
		service: "web-dev-turbo",
	},
	{
		evidence: {
			file: "apps/web-starter/src/app/(marketing)/page.tsx",
			includes: "export default",
		},
		label: "Стартовый сайт",
		project: "luvclub",
		service: "web-starter",
	},
	{
		evidence: { file: "app/page.tsx", includes: "export default" },
		label: "Приложение",
		project: "legacy-vibecoder",
		service: "app",
	},
	{
		evidence: { file: "app/page.tsx", includes: "export default" },
		label: "Приложение",
		project: "legacy-vibecoder",
		service: "app-start",
	},
	{
		evidence: {
			file: "src/server.js",
			includes: "sendHtml(response, 200, homeView",
		},
		label: "Витрина",
		project: "legacy-gameradar-postgres-only-20260908",
		service: "app",
	},
];

interface ContractService {
	health?: string;
	id: string;
	ui?: { label: string; url: string }[];
	[key: string]: unknown;
}

interface Contract {
	id: string;
	services: ContractService[];
	[key: string]: unknown;
}

export interface InterfaceChange {
	health?: string;
	service: string;
	ui?: { label: string; url: string }[];
}

/** Preserve explicit interfaces (including docs) and custom health probes. */
export function missingInterfaces(contract: Contract): InterfaceChange[] {
	const changes: InterfaceChange[] = [];
	for (const known of VERIFIED_INTERFACES.filter(
		(entry) => entry.project === contract.id
	)) {
		const service = contract.services.find(
			(entry) => entry.id === known.service
		);
		if (!service) {
			continue;
		}
		const change: InterfaceChange = { service: service.id };
		if (!service.ui?.length) {
			service.ui = [{ label: known.label, url: "/" }];
			change.ui = service.ui;
		}
		if (known.health && !service.health) {
			service.health = known.health;
			change.health = known.health;
		}
		if (change.ui || change.health) {
			changes.push(change);
		}
	}
	return changes;
}

const hash = (content: Uint8Array): string =>
	createHash("sha256").update(content).digest("hex");
const WHITESPACE = /\s+/g;
const compact = (value: string): string => value.replace(WHITESPACE, "");

function assertPrimaryStage(path: string): void {
	if (!sameSourcePath(path, primaryCheckout(path))) {
		throw new Error(
			`Interface metadata must be edited in the primary checkout: ${path}`
		);
	}
	const branch = spawnSync(
		"git",
		["-C", path, "symbolic-ref", "--short", "HEAD"],
		{
			encoding: "utf8",
			windowsHide: true,
		}
	).stdout?.trim();
	if (branch !== "stage") {
		throw new Error(
			`Interface metadata requires canonical stage: ${path} (${branch ?? "no branch"})`
		);
	}
}

async function verifyEvidence(
	path: string,
	project: string,
	changes: InterfaceChange[]
): Promise<void> {
	await Promise.all(
		changes.map(async (change) => {
			const known = VERIFIED_INTERFACES.find(
				(entry) => entry.project === project && entry.service === change.service
			);
			if (!known) {
				throw new Error(`No route evidence for ${project}/${change.service}`);
			}
			const source = await readFile(join(path, known.evidence.file), "utf8");
			if (!compact(source).includes(compact(known.evidence.includes))) {
				throw new Error(
					`Root route evidence changed: ${project}/${change.service} (${known.evidence.file})`
				);
			}
			if (change.health) {
				const health = await readFile(
					join(path, "apps/web/src/app/api/health/route.ts"),
					"utf8"
				);
				if (!health.includes("export function GET")) {
					throw new Error(
						`Health route evidence changed: ${project}/${change.service}`
					);
				}
			}
		})
	);
}

interface Proposal {
	after: string;
	afterHash: string;
	before: Buffer;
	beforeHash: string;
	changes: InterfaceChange[];
	file: string;
	id: string;
	path: string;
}

async function proposalFor(project: ProjectConfig): Promise<Proposal | null> {
	if (!VERIFIED_INTERFACES.some((entry) => entry.project === project.id)) {
		return null;
	}
	const file = join(project.path, "devhub.json");
	if (!existsSync(file)) {
		return null;
	}
	const before = await readFile(file);
	const contract = JSON.parse(before.toString("utf8")) as Contract;
	if (contract.id !== project.id) {
		throw new Error(`Manifest identity changed: ${file}`);
	}
	const changes = missingInterfaces(contract);
	if (!changes.length) {
		return null;
	}
	assertPrimaryStage(project.path);
	await verifyEvidence(project.path, project.id, changes);
	const json = `${JSON.stringify(contract, null, 2)}\n`;
	const after = before.toString("utf8").includes("\r\n")
		? json.replaceAll("\n", "\r\n")
		: json;
	return {
		after,
		afterHash: hash(Buffer.from(after)),
		before,
		beforeHash: hash(before),
		changes,
		file,
		id: project.id,
		path: project.path,
	};
}

async function assertUnchanged(proposal: Proposal): Promise<void> {
	assertPrimaryStage(proposal.path);
	if (hash(await readFile(proposal.file)) !== proposal.beforeHash) {
		throw new Error(
			`Manifest changed during interface migration: ${proposal.file}`
		);
	}
}

async function backupProposal(hub: string, proposal: Proposal): Promise<void> {
	const backup = join(
		hub,
		".state/migrations/project-management-20261003/interfaces",
		proposal.id,
		proposal.beforeHash
	);
	await mkdir(backup, { recursive: true });
	const original = join(backup, "devhub.json");
	if (existsSync(original)) {
		if (hash(await readFile(original)) !== proposal.beforeHash) {
			throw new Error(`Interface backup differs: ${original}`);
		}
	} else {
		await writeFile(original, proposal.before, { flag: "wx" });
	}
	await writeFile(
		join(backup, "change.json"),
		`${JSON.stringify({ afterHash: proposal.afterHash, beforeHash: proposal.beforeHash, changes: proposal.changes, file: proposal.file }, null, 2)}\n`
	);
}

async function writeProposal(proposal: Proposal): Promise<void> {
	await assertUnchanged(proposal);
	await writeFile(proposal.file, proposal.after);
	if (hash(await readFile(proposal.file)) !== proposal.afterHash) {
		throw new Error(`Manifest changed after interface write: ${proposal.file}`);
	}
}

async function sequential(
	proposals: Proposal[],
	work: (proposal: Proposal) => Promise<void>
): Promise<void> {
	for (const proposal of proposals) {
		// biome-ignore lint/performance/noAwaitInLoops: guarded filesystem mutations remain sequential.
		await work(proposal);
	}
}

async function writeProposals(
	hub: string,
	proposals: Proposal[]
): Promise<void> {
	const releases: (() => void)[] = [];
	const roots = [
		...new Set([hub, ...proposals.map((proposal) => proposal.path)]),
	].sort();
	try {
		for (const root of roots) {
			const stage = new StageProject(root, join(hub, ".state", "stage"));
			releases.push(stage.acquireLock());
		}
		assertPrimaryStage(hub);
		await Promise.all(
			proposals.map(async (proposal) => {
				await assertUnchanged(proposal);
				await verifyEvidence(proposal.path, proposal.id, proposal.changes);
			})
		);
		// Preserve every original before applying any contract.
		await sequential(proposals, (proposal) => backupProposal(hub, proposal));
		await sequential(proposals, writeProposal);
	} finally {
		for (const release of releases.reverse()) {
			release();
		}
	}
}

export async function projectInterfaces(
	options: { catalogue?: string; hub?: string; write?: boolean } = {}
): Promise<{
	changes: number;
	projects: Omit<Proposal, "after" | "before">[];
	write: boolean;
}> {
	const hub = primaryCheckout(options.hub ?? resolve(import.meta.dir, ".."));
	const catalogue = await loadCatalogue(
		options.catalogue ?? join(hub, "services.json")
	);
	const proposals = (
		await Promise.all(catalogue.projects.map(proposalFor))
	).filter((proposal): proposal is Proposal => proposal !== null);
	if (options.write) {
		await writeProposals(hub, proposals);
	}
	return {
		changes: proposals.reduce(
			(sum, proposal) => sum + proposal.changes.length,
			0
		),
		projects: proposals.map(
			({ after: _after, before: _before, ...proposal }) => proposal
		),
		write: options.write ?? false,
	};
}

if (import.meta.main) {
	const report = await projectInterfaces({
		write: process.argv.includes("--write"),
	});
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
