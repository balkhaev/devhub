import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface Worktree {
	branch: string | null;
	exists: boolean;
	path: string;
}
interface Repository {
	defaultRemoteBranch: string | null;
	instructionPaths: string[];
	localBranches: string[];
	primary: string;
	worktrees: Worktree[];
}
interface Policy {
	checks: string[];
	releaseBranch: string;
	stageBranch: string;
	version: 1;
	worktreeRoot: string;
}

const root = resolve(import.meta.dir, "..");
const machine = JSON.parse(
	readFileSync(join(root, "services.json"), "utf8")
) as {
	aliases?: Record<string, string>;
};
const inventoryPath =
	process.argv[2] ?? join(root, ".scratch", "worktree-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
	repos: Repository[];
};
const backupDirectory = join(root, ".scratch", "worktree-governance-backups");
const reportPath = join(root, ".scratch", "worktree-governance-report.json");
const marker = "DEVHUB:WORKTREE-POLICY";
const frontmatterPattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const originPrefixPattern = /^origin\//;
const checkTestsPattern =
	/\bnode\s+--test|\bnpm\s+(?:run\s+)?test|\bbun\s+(?:run\s+)?test/;
const pytestPattern = /\bpytest\b/;
const ruffPattern = /\bruff\b/;
const crmLifecyclePattern =
	/### Checkout and worktree lifecycle[\s\S]*?(?=### Getting access first)/;
const hubDirectReleasePattern =
	/## Drive repository changes to live without asking \(owner directive, 2026-06-25\)[\s\S]*?(?=## Repair in-scope failures)/;
const crmWorktreeIntroPattern = /^[\s\S]*?(?=При восстановлении)/;
const changed: string[] = [];
const pendingWrappers: string[] = [];
const policies: Array<{ project: string; policy: Policy; checkouts: number }> =
	[];

function writePreserving(path: string, content: string) {
	const before = existsSync(path) ? readFileSync(path, "utf8") : null;
	if (before === content) {
		return;
	}
	const backupName = createHash("sha256")
		.update(path.toLowerCase())
		.digest("hex");
	mkdirSync(backupDirectory, { recursive: true });
	const backup = join(backupDirectory, `${backupName}.json`);
	if (!existsSync(backup)) {
		writeFileSync(
			backup,
			`${JSON.stringify({ content: before, existed: before !== null, path }, null, 2)}\n`
		);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	changed.push(path);
}

function replacePolicyBlock(path: string, block: string) {
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const withoutBlock = before.replace(
		new RegExp(
			`<!-- BEGIN:${marker} -->[\\s\\S]*?<!-- END:${marker} -->\\s*`,
			"g"
		),
		""
	);
	// Keep Cursor's front matter at the top so alwaysApply remains recognized.
	const frontmatter = withoutBlock.match(frontmatterPattern);
	const body = frontmatter
		? withoutBlock.slice(frontmatter[0].length)
		: withoutBlock;
	writePreserving(
		path,
		`${frontmatter?.[0] ?? ""}${block}\n\n${body.trimStart()}`
	);
}

function releaseBranch(repo: Repository) {
	const remoteDefault = repo.defaultRemoteBranch?.replace(
		originPrefixPattern,
		""
	);
	if (remoteDefault && repo.localBranches.includes(remoteDefault)) {
		return remoteDefault;
	}
	if (repo.localBranches.includes("main")) {
		return "main";
	}
	if (repo.localBranches.includes("master")) {
		return "master";
	}
	const current = repo.worktrees[0]?.branch;
	if (current && current !== "stage") {
		return current;
	}
	const existing = join(repo.primary, ".devhub", "worktree.json");
	if (existsSync(existing)) {
		return (JSON.parse(readFileSync(existing, "utf8")) as Policy).releaseBranch;
	}
	throw new Error(`No verified release branch for ${repo.primary}`);
}

function checksFor(primary: string) {
	const packagePath = join(primary, "package.json");
	const pkg = existsSync(packagePath)
		? (JSON.parse(readFileSync(packagePath, "utf8")) as {
				scripts?: Partial<Record<string, string>>;
				packageManager?: string;
			})
		: null;
	const scripts = pkg?.scripts ?? {};
	const runner =
		pkg?.packageManager?.startsWith("bun") ||
		["bun.lock", "bun.lockb"].some((name) => existsSync(join(primary, name)))
			? "bun run"
			: "npm run";
	let keys: string[];
	if (basename(primary) === "harness") {
		keys = ["verify", "demo", "service:test", "desktop:test"];
	} else if (basename(primary) === "soclogin") {
		keys = ["verify", "build"];
	} else if (scripts["ci:check"]) {
		keys = ["ci:check"];
	} else if (scripts.verify) {
		keys = ["verify"];
	} else {
		keys = ["check-types", "check", "lint", "test", "build"];
	}
	const checkRunsTests = checkTestsPattern.test(scripts.check ?? "");
	const checks = keys
		.filter((key) => scripts[key] && !(key === "test" && checkRunsTests))
		.map((key) => `${runner} ${key}`);
	const pythonPath = join(primary, "pyproject.toml");
	if (existsSync(pythonPath)) {
		const python = readFileSync(pythonPath, "utf8");
		if (pytestPattern.test(python)) {
			checks.push("uv run --no-sync pytest");
		}
		if (ruffPattern.test(python)) {
			checks.push("uv run --no-sync ruff check .");
		}
	}
	return checks;
}

function blockFor(primary: string, policy: Policy) {
	return `<!-- BEGIN:${marker} -->
## DevHub staging and worktrees — owner policy, 2026-10-03

The canonical checkout is \`${primary}\`. Its local integration branch is
\`${policy.stageBranch}\`; the release branch is \`${policy.releaseBranch}\`.
Read the canonical [worktree policy](${primary}/.devhub/worktree.json) and
[workflow](D:/code/devhub/WORKTREES.md) before changing repository state.

- Author task changes in an isolated worktree on \`codex/<task>\`, created from the canonical staging branch. Reuse a suitable existing task worktree; do not create another clone.
- Integrate the completed task into the canonical staging checkout, then run final repository checks and inspect the application there. Worktree checks alone do not complete final validation.
- DevHub starts every development service from the canonical project directory. Never run a dev server from a linked worktree or register a worktree as a second application. A worktree's dev command routes to the canonical checkout and displays only integrated changes.
- Use \`bun D:/code/devhub/src/stage.ts create|integrate|check|status|finish --project "${primary}" [task-or-ref-or-path]\`; JavaScript repositories also expose \`npm run worktree -- <command> [task-or-ref-or-path]\` / \`bun run worktree <command> [task-or-ref-or-path]\`. Create takes a task name, integrate takes a Git ref or checkout path, finish takes the full worktree path.
- Preserve unrelated edits, untracked files, ignored private files and other agents' work. If integration is unsafe, report the concrete conflict and keep both checkouts intact. Never reset, force-remove, stash all changes or bulk-merge existing worktrees to make staging clean.
- Release happens only after canonical staging validation and when the current task explicitly authorizes release. Prior direct-to-main, automatic push/deploy, no-feature-branch and forced worktree-cleanup instructions are superseded by this staging policy. Project-specific release verification and security rules still apply when a release is authorized.
- Remove a finished worktree only after its commits are contained in staging and its tracked, untracked and private ignored files are safely preserved. For Codex-managed worktrees use the app's archive operation so its attachment stays consistent.

Production \`build\`, \`start\`, \`deploy\` and container entrypoints remain standalone.
<!-- END:${marker} -->`;
}

function reconcileLegacyInstructions(path: string, primary: string) {
	if (!existsSync(path)) {
		return;
	}
	let text = readFileSync(path, "utf8");
	const original = text;
	if (basename(primary) === "girls") {
		text = text.replace(
			"1. Land the target commit on `main` and push it to `origin`.",
			"1. Integrate the target commit into canonical `stage`, run final checks there, then promote to `main` and push only when the current task authorizes release."
		);
		text = text.replace(
			"3. No tags, no manual deploy step, no staging branch. Verify the change against",
			"3. The local `stage` branch is the required integration and final-validation gate. After an authorized release, verify the change against"
		);
	}
	if (basename(primary) === "predict") {
		text = text.replace(
			"13. Finished, tested work is merged into `main` and pushed (owner instruction, 2026-09-25); keep status/changelog and test evidence in the same change.",
			"13. Integrate completed work into canonical `stage` and run final validation there (owner instruction, 2026-10-03). Promote to `main` and push only when the current task authorizes release; keep status/changelog and test evidence in the same change."
		);
	}
	if (basename(primary) === "zemstroy-crm") {
		text = text.replace(
			crmLifecyclePattern,
			`### Checkout and worktree lifecycle\n\nTask changes use isolated \`codex/<task>\` worktrees created through the shared\nDevHub staging CLI. The canonical checkout at \`${primary}\` runs on\n\`stage\`; integrate task commits there and run final checks through\n\`bun run worktree check\`. DevHub starts this canonical checkout.\n\nUse \`bun run worktree create <task>\`, \`status\`, \`integrate <ref>\`,\n\`check\` and \`finish <full-worktree-path>\`. New task worktrees live under\n\`D:/code/.worktrees/zemstroy-crm/\`; existing worktrees remain recoverable.\nDo not create another clone or sibling application directory, reset unrelated\nchanges, force-remove worktrees or delete Git metadata.\n\nOnly after staging passes and the current task authorizes release, promote the\nvalidated changes to \`main\` and push. Wait for a successful production deployment,\nverify the requested behavior and repair failures within that authorized release.\nKeep commits scoped and record exact validation evidence.\n\n`
		);
	}
	if (
		basename(primary) === "hub" &&
		path.replaceAll("\\", "/").endsWith("/AGENTS.md")
	) {
		text = text.replace(
			hubDirectReleasePattern,
			"## Stage first, then an authorized release (owner directive, 2026-10-03)\n\nAuthor repository changes in an isolated task worktree and integrate them into\nthe canonical `D:/code/hub` checkout on `stage`. Run final local gates there\n(`bun run ci:check`, relevant tests and rendered inspection where applicable).\nDo not push or deploy merely because implementation checks passed.\n\nWhen the current task authorizes release, promote the validated staging changes\nto `main` and push the scoped commit. The existing Coolify webhook remains the\ndeploy trigger; do not trigger a second deployment after a healthy webhook.\nInclude pending migrations, verify the released surface and record evidence in\n`docs/AGENT_CHANGELOG.md` / `docs/AGENT_STATUS.md`.\n\n"
		);
	}
	if (text !== original) {
		writePreserving(path, text);
	}
}

function reconcileCheckoutDocs(folder: string, primary: string) {
	if (basename(primary) !== "zemstroy-crm") {
		return;
	}
	const worktreesPath = join(folder, "docs", "worktrees.md");
	if (existsSync(worktreesPath)) {
		const before = readFileSync(worktreesPath, "utf8");
		const intro =
			"# Рабочая копия, staging и worktree\n\nОсновной проект: `D:/code/zemstroy-crm`, ветка `stage`. Это общий\nлокальный стенд интеграции и финальной проверки. Изменения задач создаются\nв отдельных worktree на `codex/<задача>` от текущего stage. DevHub запускает\nсерверы только из основной папки проекта. Dev-команда из worktree показывает\nуже влитый канонический stage.\n\nОбщие правила: [DevHub worktrees](D:/code/devhub/WORKTREES.md).\nМашинный контракт: [worktree.json](D:/code/zemstroy-crm/.devhub/worktree.json).\n\n```powershell\nbun run worktree status\nbun run worktree create inventory-search\nbun run worktree integrate codex/inventory-search\nbun run worktree check\nbun run worktree finish D:/code/.worktrees/zemstroy-crm/inventory-search\n```\n\nНовая задача использует `D:/code/.worktrees/zemstroy-crm/<задача>`.\nПовтор create возвращает зарегистрированный worktree той же задачи.\nИнтеграция требует чистого stage и сохранённой работы в исходном worktree;\nпосле merge CLI выполняет финальные проверки из основной папки.\nЛокальные правки нельзя reset, автоматически stash или включать в чужой commit.\n\nFinish принимает полный путь и удаляет только чистый worktree из управляемой\nпапки, если его commit уже включён в текущий проверенный stage. Игнорируемые\nличные файлы, `.env` и outputs должны быть заранее сохранены. Ветка задачи\nсохраняется. Worktree, созданные приложением Codex, архивируются через само\nприложение; другие активные деревья не удаляются ради завершения задачи.\n\nProduction остаётся на `main`: выпуск и push выполняются только после\nпроверки stage и в рамках явного запроса на выпуск. Не создавайте отдельные\nклоны `zemstroy-crm-*` и не удаляйте Git metadata.\n\n";
		writePreserving(
			worktreesPath,
			before
				.replace(crmWorktreeIntroPattern, intro)
				.replace("с текущим `main`.", "с текущим `stage`.")
		);
	}
	const accessPath = join(folder, "docs", "access.md");
	if (existsSync(accessPath)) {
		const before = readFileSync(accessPath, "utf8");
		const after = before
			.replace(
				"4. Работать в основном checkout; правила дополнительных worktree — в `docs/worktrees.md`.",
				"4. Изменять код в worktree задачи; вливать и окончательно проверять в основном checkout на `stage`. Правила — в `docs/worktrees.md`."
			)
			.replace(
				"- Рабочая ветка: `main`. Пуш в `main` запускает автоматическую выкладку в прод.",
				"- Локальная интеграция и dev: `stage`. Выпуск: `main`; push запускает production только в рамках явно разрешённого выпуска после проверки stage."
			)
			.replace(
				"**Основной checkout — `D:\\code\\zemstroy-crm`, ветка `main`.**",
				"**Основной checkout — `D:\\code\\zemstroy-crm`, ветка `stage`.**"
			)
			.replace(
				"используйте `bun run worktree new <имя-задачи>`.",
				"используйте `bun run worktree create <имя-задачи>`; финальная проверка выполняется в каноническом stage."
			);
		writePreserving(accessPath, after);
	}
}

const wrapperPath = join(root, "templates", "worktree.cjs");
const wrapper = existsSync(wrapperPath)
	? readFileSync(wrapperPath, "utf8")
	: null;
for (const repo of inventory.repos) {
	if (!existsSync(join(repo.primary, ".git"))) {
		continue;
	}
	const policy: Policy = {
		checks: checksFor(repo.primary),
		releaseBranch: releaseBranch(repo),
		stageBranch: "stage",
		version: 1,
		worktreeRoot: `../.worktrees/${basename(repo.primary)}`,
	};
	const policyPath = join(repo.primary, ".devhub", "worktree.json");
	// Preserve an equivalent policy's formatting so the project's formatter and a repeat migration agree.
	const existingPolicy = existsSync(policyPath)
		? JSON.parse(readFileSync(policyPath, "utf8"))
		: null;
	if (JSON.stringify(existingPolicy) !== JSON.stringify(policy)) {
		writePreserving(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
	}
	const canonicalAlias = Object.entries(machine.aliases ?? {}).find(
		([from]) =>
			resolve(from).toLowerCase() === resolve(repo.primary).toLowerCase()
	)?.[1];
	const block = blockFor(
		canonicalAlias ? resolve(canonicalAlias) : repo.primary,
		policy
	);
	const checkouts = repo.worktrees.filter(
		(tree) => tree.exists && existsSync(join(tree.path, ".git"))
	);
	for (const tree of checkouts) {
		const agents = join(tree.path, "AGENTS.md");
		reconcileLegacyInstructions(agents, repo.primary);
		replacePolicyBlock(agents, block);
		const claude = join(tree.path, "CLAUDE.md");
		if (existsSync(claude)) {
			replacePolicyBlock(claude, block);
		}
		reconcileCheckoutDocs(tree.path, repo.primary);
		const cursor = join(tree.path, ".cursor", "rules", "devhub-staging.mdc");
		if (!existsSync(cursor)) {
			writePreserving(
				cursor,
				"---\ndescription: Canonical DevHub staging and isolated task worktrees\nalwaysApply: true\n---\n\n"
			);
		}
		replacePolicyBlock(cursor, block);
		if (wrapper) {
			writePreserving(join(tree.path, ".devhub", "worktree.cjs"), wrapper);
		} else {
			pendingWrappers.push(tree.path);
		}
		const pkgPath = join(tree.path, "package.json");
		if (existsSync(pkgPath) && tree.path !== root.replaceAll("\\", "/")) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
				scripts?: Record<string, string>;
			};
			pkg.scripts ??= {};
			pkg.scripts.worktree = "node .devhub/worktree.cjs";
			writePreserving(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
		}
	}
	policies.push({ checkouts: checkouts.length, policy, project: repo.primary });
}

const genericParent = `<!-- BEGIN:${marker} -->\n## Worktrees and canonical staging — owner policy, 2026-10-03\n\nEvery application has one canonical primary checkout on local \`stage\`. Task\nchanges are authored in isolated \`codex/<task>\` worktrees, integrated into that\nprimary checkout and finally checked there. DevHub always starts canonical\nproject folders. It never starts an application's linked worktree.\n\nRead the project's canonical \`.devhub/worktree.json\` and\n[D:/code/devhub/WORKTREES.md](D:/code/devhub/WORKTREES.md). Use the shared\n\`bun D:/code/devhub/src/stage.ts\` CLI for create, integrate, check, status and\nfinish. Preserve dirty work; no reset, force cleanup or automatic bulk merges.\nProduction release follows successful staging checks and explicit release scope\nin the current task. This owner policy supersedes older direct-main, automatic\npush/deploy and conflicting worktree-lifecycle instructions in repositories.\nProject security and release-verification requirements remain in force.\n<!-- END:${marker} -->`;
replacePolicyBlock("D:/code/AGENTS.md", genericParent);
replacePolicyBlock("C:/Users/user/Documents/ChatGPT/AGENTS.md", genericParent);
const parentInstructions = readFileSync("D:/code/AGENTS.md", "utf8");
writePreserving(
	"D:/code/AGENTS.md",
	parentInstructions.replace(
		"Более конкретные инструкции внутри репозиториев сохраняют силу. Этот файл задаёт общий контракт запуска локальной разработки.",
		"Предметные инструкции и требования безопасности внутри репозиториев сохраняют силу. Контракт канонического stage и worktree от 2026-10-03 имеет приоритет над прежними правилами прямого main/push/deploy и жизненного цикла worktree."
	)
);

const hubShared = "D:/code/hub/docs/AGENT_SHARED_CONTEXT.md";
if (existsSync(hubShared)) {
	const before = readFileSync(hubShared, "utf8");
	const stageSection = `## Staging And Deploy\n\nThe owner policy of 2026-10-03 supersedes the previous direct-main workflow.\n\n- \`D:/code/hub\` is the canonical development and integration checkout on \`stage\`. Task changes use isolated \`codex/<task>\` worktrees created from staging with the shared DevHub CLI. New worktrees live under \`D:/code/.worktrees/hub/\`.\n- Inspect status and scoped diffs before changes. Preserve other agents' files and commits. Do not reset, bulk-stash, force-remove or automatically merge existing worktrees.\n- Integrate completed task commits into canonical staging, run \`bun run ci:check\` and relevant tests there, then inspect the affected development surface through DevHub. Worktree checks alone are not final validation.\n- Use \`bun run worktree create|integrate|check|status|finish\`; canonical \`.devhub/worktree.json\` owns branch names and check commands.\n- Finish only a clean worktree whose commits are contained in staging; preserve ignored private files. Codex-managed worktrees must be archived through the app. Do not remove other agents' active checkouts at handoff.\n- When the current task authorizes production release, promote the validated staging changes to \`main\` and push only scoped changes. Existing Coolify webhooks remain the deployment trigger. Watch paths still scope deployed apps.\n- Apply pending migrations through the production entrypoint. Verify the released surface, logs and durable readback, repair authorized release failures and record evidence. Manual Coolify deploy/restart is only for webhook failure, environment changes, new app wiring or rollout recovery.\n- Production inventory and runbooks remain in [deploy/README.md](deploy/README.md). When GitHub Actions cannot run, use local \`bun run ci:check\`; after an authorized release use \`bun run ci:verify-prod\`.\n\n`;
	const after = before
		.replace(
			/## Mainline And Deploy[\s\S]*?(?=## Product contour handoff)/,
			stageSection
		)
		.replace(
			"commit and push without creating Hub runtime work.",
			"integrate into canonical staging and validate there; release only when the current task authorizes it, without creating Hub runtime work."
		);
	writePreserving(hubShared, after);
	replacePolicyBlock(
		"D:/code/hub/docs/AGENT_OPERATING_CONTRACT.md",
		genericParent
	);
	const changelogPath = "D:/code/hub/docs/AGENT_CHANGELOG.md";
	const changelog = readFileSync(changelogPath, "utf8");
	const entry = "## 2026-10-03 — Canonical DevHub staging and worktrees";
	const entryBlock = `${entry}\n\nLocal repository work now uses isolated task worktrees and canonical \`stage\`\nintegration at \`D:/code/hub\`. Final checks and development servers run only\nfrom that checkout. The shared DevHub staging CLI and canonical\n\`.devhub/worktree.json\` replace the former direct-main and force-cleanup rules.\nRelease to \`main\` remains a separate explicitly authorized action. Existing\ndirty work, commits and production state were preserved by this governance\nmigration. Validation is recorded in DevHub's worktree migration report.\n`;
	if (!changelog.includes(entry)) {
		writePreserving(
			changelogPath,
			changelog.replace(/\r?\n## /, `\n${entryBlock}\n## `)
		);
	} else if (changelog.startsWith(entry)) {
		const withoutEarlyEntry = changelog.replace(
			/^## 2026-10-03 — Canonical DevHub staging and worktrees[\s\S]*?(?=^# )/m,
			""
		);
		writePreserving(
			changelogPath,
			withoutEarlyEntry.replace(/\r?\n## /, `\n${entryBlock}\n## `)
		);
	}
}

const touchedPaths = readdirSync(backupDirectory)
	.filter((name) => name.endsWith(".json"))
	.map(
		(name) =>
			(
				JSON.parse(readFileSync(join(backupDirectory, name), "utf8")) as {
					path: string;
				}
			).path
	);
const report = {
	changed: [...new Set(changed)],
	checkouts: policies.reduce((n, p) => n + p.checkouts, 0),
	generatedAt: new Date().toISOString(),
	pendingWrappers,
	policies,
	projects: policies.length,
	totalTouched: touchedPaths.length,
	touchedPaths,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	JSON.stringify(
		{
			changed: report.changed.length,
			checkouts: report.checkouts,
			pendingWrappers: pendingWrappers.length,
			projects: report.projects,
			releases: policies.map((p) => ({
				branch: p.policy.releaseBranch,
				checks: p.policy.checks,
				project: p.project,
			})),
			reportPath,
		},
		null,
		2
	)
);
