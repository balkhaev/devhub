import { expect, test } from "bun:test";

import { actionWords as words } from "../src/server";

test("an action's address is said in words for the journal", () => {
	expect(words("/api/docker/gameradar/stop")).toBe(
		"Docker gameradar: остановить"
	);
	expect(words("/api/projects/montage/start")).toBe(
		"проект montage: запустить"
	);
	expect(words("/api/services/altay/site/restart")).toBe(
		"altay/site: перезапустить"
	);
});
