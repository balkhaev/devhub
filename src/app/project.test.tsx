import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProjectView, ServiceView } from "../hub";
import type { DeletionPlan } from "../projects";
import { deleteProject, projectDeletionPlan, setProjectMode } from "./api";
import { ProjectPage } from "./project";
import { ProjectControls } from "./project-controls";
import { DeleteProjectDialog, DeletionDetails } from "./project-delete";
import { mainFrontend } from "./project-ui";

const noop = () => undefined;
const DISABLED_DELETE = /<button[^>]+disabled=""[^>]*>Удалить проект<\/button>/;

function service(id: string, changes: Partial<ServiceView> = {}): ServiceView {
	return {
		canStart: true,
		command: "bun app.ts",
		description: null,
		elsewhere: null,
		exit: null,
		health: null,
		key: `sample/${id}`,
		managed: false,
		name: id,
		needs: [],
		owner: null,
		pid: null,
		port: 5000,
		project: "sample",
		since: null,
		status: "stopped",
		ui: [{ label: "Приложение", url: "http://127.0.0.1:5000/" }],
		warn: null,
		workdir: "D:/code/sample",
		...changes,
	};
}

function project(changes: Partial<ProjectView> = {}): ProjectView {
	return {
		currentBranch: "stage",
		deletable: true,
		description: null,
		devServices: ["sample/web"],
		docker: null,
		id: "sample",
		integrationBranch: "stage",
		localOnly: false,
		mode: "prod",
		modeEditable: true,
		name: "Sample",
		path: "D:/code/sample",
		releaseBranch: "main",
		services: [service("web")],
		stageBranch: "stage",
		...changes,
	};
}

test("the default dev frontend wins over an optional service", () => {
	const optional = service("paid", {
		ui: [{ label: "Other", url: "http://127.0.0.1:5001/" }],
	});
	const primary = service("web");
	expect(
		mainFrontend(project({ services: [optional, primary] }))?.service.key
	).toBe("sample/web");
});

test("API documentation is skipped while the declared frontend order is kept", () => {
	const api = service("web", {
		ui: [{ label: "API", url: "http://127.0.0.1:5000/docs" }],
	});
	const generation = service("generation", {
		ui: [
			{ label: "H3 / Видео", url: "http://127.0.0.1:5001/video/" },
			{ label: "Qwen", url: "http://127.0.0.1:5001/qwen/" },
		],
	});
	const frontend = mainFrontend(project({ services: [api, generation] }));
	expect(frontend?.label).toBe("H3 / Видео");
	expect(frontend?.url).toBe("http://127.0.0.1:5001/video/");
	expect(mainFrontend(project({ services: [api] }))).toBeNull();
});

test("main dev controls do not offer starting only an optional paid service", () => {
	const primary = service("web", { managed: true, status: "running" });
	const optional = service("paid", { warn: "Uses a paid model" });
	const markup = renderToStaticMarkup(
		<ProjectControls project={project({ services: [primary, optional] })} />
	);
	expect(markup).not.toContain("Запустить dev");
	expect(markup).toContain("Остановить dev");
});

test("a project without services still shows its primary folder and deletion control", () => {
	const markup = renderToStaticMarkup(
		<ProjectPage
			onDeleted={noop}
			project={project({ devServices: [], services: [] })}
		/>
	);
	expect(markup).toContain("D:/code/sample");
	expect(markup).toContain("stage");
	expect(markup).toContain("Удалить проект…");
	expect(markup).toContain("Dev-сервисы ещё не настроены");
});

test("MVP uses main for dev and explains immediate release, while Prod uses stage", () => {
	const mvp = renderToStaticMarkup(
		<ProjectPage
			onDeleted={noop}
			project={project({
				currentBranch: "main",
				integrationBranch: "main",
				mode: "mvp",
			})}
		/>
	);
	expect(mvp).toContain("MVP");
	expect(mvp).toContain('value="mvp" selected=""');
	expect(mvp).toContain("сразу идут в");
	expect(mvp).toContain("Завершённый worktree удаляется");
	expect(mvp).not.toContain("Для dev основная папка должна быть");
	const prod = renderToStaticMarkup(
		<ProjectPage
			onDeleted={noop}
			project={project({ currentBranch: "main" })}
		/>
	);
	expect(prod).toContain('value="prod" selected=""');
	expect(prod).toContain("отдельного разрешения");
	expect(prod).toContain("Для dev основная папка должна быть на ветке stage");
});

test("an invalid or missing workflow has no writable or invented mode", () => {
	const markup = renderToStaticMarkup(
		<ProjectPage
			onDeleted={noop}
			project={project({
				integrationBranch: null,
				mode: null,
				modeEditable: false,
				releaseBranch: null,
				stageBranch: null,
			})}
		/>
	);
	expect(markup).toContain("Режим не настроен");
	expect(markup).toContain('<select disabled="">');
	expect(markup).not.toContain("сразу идут в");
	expect(markup).not.toContain("Для dev основная папка должна быть");
});

test("local-only MVP projects describe saving in local main without claiming a production release", () => {
	const markup = renderToStaticMarkup(
		<ProjectPage
			onDeleted={noop}
			project={project({
				currentBranch: "main",
				integrationBranch: "main",
				localOnly: true,
				mode: "mvp",
			})}
		/>
	);
	expect(markup).toContain("изменения сохраняются в локальном");
	expect(markup).toContain("<strong>main</strong>");
	expect(markup).toContain("Завершённый worktree удаляется после задачи");
	expect(markup).not.toContain("и прод");
	expect(markup).not.toContain("сразу идут");
});

const plan: DeletionPlan = {
	blockers: ["Another project depends on this folder"],
	id: "sample",
	name: "Sample",
	paths: [
		{ kind: "project", path: "D:/code/sample" },
		{ kind: "worktree", path: "D:/code/.worktrees/sample/task" },
		{ kind: "alias", path: "D:/old/sample" },
	],
	token: "private-review-token",
	warnings: ["Local files <including env> will be deleted"],
};

test("deletion review shows every included path, impact and blocker without exposing its token", () => {
	const markup = renderToStaticMarkup(<DeletionDetails plan={plan} />);
	for (const entry of plan.paths) {
		expect(markup).toContain(entry.path);
	}
	expect(markup).toContain("Старая копия");
	expect(markup).toContain("Worktree");
	expect(markup).toContain("Пока нельзя удалить");
	expect(markup).toContain(plan.blockers[0] ?? "");
	expect(markup).toContain("&lt;including env&gt;");
	expect(markup).not.toContain(plan.token);
});

test("opening deletion cannot execute before its plan has loaded", () => {
	const markup = renderToStaticMarkup(
		<DeleteProjectDialog onClose={noop} onDeleted={noop} project={project()} />
	);
	expect(markup).toContain("Проверяю папки и зависимости");
	expect(markup).toContain("без корзины");
	expect(markup).toMatch(DISABLED_DELETE);
});

test("the plan request is read-only POST and does not call the deletion endpoint", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ ok: true, result: plan })
	);
	try {
		expect(await projectDeletionPlan("sample")).toEqual(plan);
		expect(fetcher.mock.calls).toHaveLength(1);
		expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/sample/delete-plan");
		expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
		expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
		expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
			"Content-Type": "application/json",
			"x-devhub": "1",
		});
	} finally {
		fetcher.mockRestore();
	}
});

test("deletion submits exactly the reviewed token and never retries an expired plan", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ error: "Plan expired", ok: false }, { status: 409 })
	);
	try {
		await expect(deleteProject("sample", plan.token)).rejects.toThrow(
			"Plan expired"
		);
		expect(fetcher.mock.calls).toHaveLength(1);
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({ token: plan.token })
		);
	} finally {
		fetcher.mockRestore();
	}
});

test("mode changes submit an authenticated mode request and retain API errors", async () => {
	const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ error: "Branches diverged", ok: false }, { status: 409 })
	);
	try {
		await expect(setProjectMode("sample", "mvp")).rejects.toThrow(
			"Branches diverged"
		);
		expect(fetcher.mock.calls).toHaveLength(1);
		expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/sample/mode");
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({ mode: "mvp" })
		);
		expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
			"Content-Type": "application/json",
			"x-devhub": "1",
		});
	} finally {
		fetcher.mockRestore();
	}
});
