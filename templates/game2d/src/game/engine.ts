export const SAVE_VERSION = 1;
export const MAX_OFFLINE_SECONDS = 8 * 60 * 60;

export interface GameState {
  version: typeof SAVE_VERSION;
  credits: number;
  workers: number;
  level: number;
  totalEarned: number;
  lastTick: number;
}

export function createState(now = Date.now()): GameState {
  return { version: SAVE_VERSION, credits: 12, workers: 1, level: 0, totalEarned: 0, lastTick: now };
}

export function incomePerSecond(state: GameState): number {
  return state.workers * (1 + state.level * 0.35);
}

export function workerCost(state: GameState): number {
  return Math.round(25 * 1.65 ** (state.workers - 1));
}

export function upgradeCost(state: GameState): number {
  return Math.round(60 * 1.8 ** state.level);
}

/** Advances one simulation clock, capped at eight hours. Clock rollback never creates income. */
export function advance(state: GameState, now = Date.now()): number {
  if (!Number.isFinite(now) || now <= state.lastTick) return 0;
  const elapsed = Math.min((now - state.lastTick) / 1000, MAX_OFFLINE_SECONDS);
  const earned = elapsed * incomePerSecond(state);
  state.credits += earned;
  state.totalEarned += earned;
  state.lastTick = now;
  return earned;
}

export function collect(state: GameState): number {
  const earned = 1 + state.level * 0.5;
  state.credits += earned;
  state.totalEarned += earned;
  return earned;
}

export function hireWorker(state: GameState): boolean {
  const cost = workerCost(state);
  if (state.credits < cost || state.workers >= 100) return false;
  state.credits -= cost;
  state.workers += 1;
  return true;
}

export function upgradeWorkshop(state: GameState): boolean {
  const cost = upgradeCost(state);
  if (state.credits < cost || state.level >= 100) return false;
  state.credits -= cost;
  state.level += 1;
  return true;
}

/** Untrusted browser saves need a version and valid bounds before they enter the simulation. */
export function parseSave(text: string | null, now = Date.now()): GameState {
  if (!text) return createState(now);
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object") return createState(now);
    const value = data as Record<string, unknown>;
    const nonnegative = (field: unknown): field is number => typeof field === "number" && Number.isFinite(field) && field >= 0;
    if (
      value.version !== SAVE_VERSION ||
      !nonnegative(value.credits) || value.credits > 1e15 ||
      !nonnegative(value.totalEarned) || value.totalEarned > 1e15 ||
      !nonnegative(value.lastTick) ||
      !nonnegative(value.workers) || !Number.isInteger(value.workers) || value.workers < 1 || value.workers > 100 ||
      !nonnegative(value.level) || !Number.isInteger(value.level) || value.level > 100
    ) return createState(now);
    return { version: SAVE_VERSION, credits: value.credits, workers: value.workers, level: value.level, totalEarned: value.totalEarned, lastTick: Math.min(value.lastTick, now) };
  } catch {
    return createState(now);
  }
}
