import { describe, expect, test } from "bun:test";
import { advance, collect, createState, hireWorker, incomePerSecond, MAX_OFFLINE_SECONDS, parseSave, upgradeWorkshop, workerCost } from "../src/game/engine";

describe("idle economy", () => {
  test("time split across frames earns the same amount as one offline interval", () => {
    const online = createState(1000);
    const offline = createState(1000);
    for (let second = 1; second <= 60; second += 1) advance(online, 1000 + second * 1000);
    advance(offline, 61000);
    expect(online).toEqual(offline);
    expect(online.credits).toBe(72);
  });

  test("offline catch-up is capped and consumes the entire elapsed clock once", () => {
    const state = createState(1000);
    expect(advance(state, 1000 + 24 * 60 * 60 * 1000)).toBe(MAX_OFFLINE_SECONDS);
    expect(advance(state, state.lastTick)).toBe(0);
    expect(advance(state, 500)).toBe(0);
    expect(state.totalEarned).toBe(MAX_OFFLINE_SECONDS);
  });

  test("a purchase is atomic when money is insufficient", () => {
    const state = createState(0);
    const before = { ...state };
    expect(hireWorker(state)).toBe(false);
    expect(upgradeWorkshop(state)).toBe(false);
    expect(state).toEqual(before);
    advance(state, 13000);
    const cost = workerCost(state);
    expect(hireWorker(state)).toBe(true);
    expect(state.credits).toBe(25 - cost);
    expect(incomePerSecond(state)).toBe(2);
  });

  test("upgrades improve passive and manual production without adding money", () => {
    const state = createState(0);
    state.credits = 100;
    expect(upgradeWorkshop(state)).toBe(true);
    expect(state.credits).toBe(40);
    expect(incomePerSecond(state)).toBe(1.35);
    expect(collect(state)).toBe(1.5);
    expect(state.credits).toBe(41.5);
  });
});

describe("save restoration", () => {
  test("valid save survives reload and catches up once", () => {
    const state = createState(1000);
    state.credits = 20;
    const restored = parseSave(JSON.stringify(state), 11000);
    expect(advance(restored, 11000)).toBe(10);
    expect(advance(restored, 11000)).toBe(0);
    expect(restored.credits).toBe(30);
  });

  test("malformed, future-version and malicious saves fall back to a fresh game", () => {
    for (const text of ["{", "null", "[]", JSON.stringify({ ...createState(0), version: 99 }), JSON.stringify({ ...createState(0), workers: -2 }), JSON.stringify({ ...createState(0), credits: 1e20 })]) {
      expect(parseSave(text, 1000)).toEqual(createState(1000));
    }
  });

  test("a future timestamp cannot freeze production after a clock correction", () => {
    const saved = createState(20000);
    const restored = parseSave(JSON.stringify(saved), 1000);
    expect(advance(restored, 2000)).toBe(1);
  });
});
