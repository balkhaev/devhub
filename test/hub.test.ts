import { expect, test } from "bun:test";

import type { ContainerView, DockerView } from "../src/docker";
import {
	checkoutOf,
	type OwnerView,
	publishedPorts,
	samePath,
	worthShowing,
} from "../src/hub";

test("the checkout is the folder before the tools a server runs from", () => {
	expect(
		checkoutOf([
			"C:\\Users\\user\\Documents\\ChatGPT\\mediapipes\\.venv\\Scripts\\python.exe -m uvicorn mediapipes.api.app:create_app --port 8088",
		])
	).toBe("C:\\Users\\user\\Documents\\ChatGPT\\mediapipes");
	expect(
		checkoutOf([
			"bun D:/code/montage/.claude/worktrees/3d-scene/apps/cli/src/main.ts studio",
		])
	).toBe("D:\\code\\montage\\.claude\\worktrees\\3d-scene");
	expect(
		checkoutOf([
			'"C:\\Program Files\\nodejs\\node.exe" D:\\code\\altay\\node_modules\\vite\\bin\\vite.js',
		])
	).toBe("D:\\code\\altay");
});

test("the first command line that names a checkout wins, parents after children", () => {
	// Predict's supervisor names no path; its parent runs from the Laya environment inside the checkout.
	expect(
		checkoutOf([
			"python.exe -m predict.runtime --port 8080",
			"D:\\code\\predict\\.venv-laya\\Scripts\\python.exe -m predict.laya_local",
			"D:\\code\\other\\src\\x.py",
		])
	).toBe("D:\\code\\predict");
	expect(checkoutOf(["python.exe -m predict.runtime --port 8080"])).toBeNull();
});

test("paths compare regardless of slashes, case and a trailing slash", () => {
	expect(samePath("D:/code/montage", "d:\\code\\montage\\")).toBe(true);
	expect(samePath("D:/code/montage", "D:/code/modeler")).toBe(false);
});

const container = (
	ports: string,
	running = true,
	service = "app"
): ContainerView => ({
	exitCode: running ? null : 0,
	health: null,
	name: `${service}-1`,
	ports,
	running,
	service,
	status: running ? "Up 2 hours" : "Exited (0) 1 hour ago",
});

test("published ports belong to the compose project whose running container publishes them", () => {
	const docker: DockerView = {
		available: true,
		projects: [
			{
				containers: [
					container("0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp"),
					container("0.0.0.0:5433->5432/tcp", false, "postgres"),
				],
				file: null,
				name: "gameradar",
				project: "gameradar",
				ready: true,
				status: "running(1)",
				wanted: [],
			},
			{
				containers: [container("127.0.0.1:9222->9222/tcp")],
				file: null,
				name: "soclogin",
				project: null,
				ready: true,
				status: "running(1)",
				wanted: [],
			},
		],
	};
	const ports = publishedPorts(docker);
	expect(ports.get(3000)).toBe("gameradar");
	expect(ports.get(9222)).toBe("soclogin");
	expect(ports.has(5433)).toBe(false);
});

test("without tool folders the checkout is the project folder under the code folder", () => {
	expect(
		checkoutOf(
			[
				"C:/Users/user/AppData/Local/Programs/Python/Python313/python.exe -m http.server 8777 --directory D:/code/montage-scene-composer",
			],
			"D:/code"
		)
	).toBe("D:\\code\\montage-scene-composer");
	expect(
		checkoutOf(["C:/Python313/python.exe -m http.server 8777"], "D:/code")
	).toBeNull();
});

const owner = (name: string, extra: Partial<OwnerView> = {}): OwnerView => ({
	checkout: null,
	command: "",
	docker: null,
	label: name,
	name,
	pid: 10,
	...extra,
});

test("the port list keeps dev servers and Docker, not every program that listens", () => {
	const show = (port: number, who: OwnerView, service: string | null = null) =>
		worthShowing({ owner: who, port, service });
	expect(show(8777, owner("python.exe"))).toBe(true);
	expect(
		show(3000, owner("com.docker.backend.exe", { docker: "gameradar" }))
	).toBe(true);
	expect(show(8194, owner("python.exe"), "inference/comfyui")).toBe(true);
	expect(show(5000, owner("helper.exe", { checkout: "D:\\code\\tool" }))).toBe(
		true
	);
	expect(show(6463, owner("Discord.exe"))).toBe(false);
	expect(show(27_036, owner("steam.exe"))).toBe(false);
	expect(show(52_886, owner("node.exe"))).toBe(false);
	expect(show(135, owner("svchost.exe"))).toBe(false);
});
