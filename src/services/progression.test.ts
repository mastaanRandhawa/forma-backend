import { describe, it, expect } from "vitest";
import { applyRules, deriveTier, computeNextUnlock, type ProgressionCounters } from "./progression.js";
import { ALL_FEATURES, ALWAYS_FEATURES } from "../data/progression.js";

const zero: ProgressionCounters = {
  finishedSessions: 0,
  activeDays: 0,
  prCount: 0,
  achievementCount: 0,
  walletBalance: 0,
  chatMessagesSent: 0,
  daysSinceFirstRun: 0,
};
const c = (over: Partial<ProgressionCounters>): ProgressionCounters => ({ ...zero, ...over });

describe("progression rules", () => {
  it("a brand-new user has exactly the always-on features (baseline, not 'newly')", () => {
    const { unlocked, newlyUnlocked } = applyRules(zero, []);
    expect([...unlocked].sort()).toEqual([...ALWAYS_FEATURES].sort());
    expect(newlyUnlocked).toEqual([]); // always-on features are the baseline
    expect(deriveTier(unlocked)).toBe("starter");
  });

  it("one finished session unlocks body_map + progress_basic (building tier)", () => {
    const { unlocked, newlyUnlocked } = applyRules(c({ finishedSessions: 1 }), ALWAYS_FEATURES);
    expect(unlocked.has("body_map")).toBe(true);
    expect(unlocked.has("progress_basic")).toBe(true);
    expect(unlocked.has("goals")).toBe(false);
    expect(newlyUnlocked).toContain("body_map");
    expect(deriveTier(unlocked)).toBe("building");
  });

  it("goals unlocks via the OR branch (3 active days, 0 sessions)", () => {
    const { unlocked } = applyRules(c({ activeDays: 3 }), ALWAYS_FEATURES);
    expect(unlocked.has("goals")).toBe(true);
  });

  it("store requires achievements AND wallet > 0 (prereq chain resolves)", () => {
    const noCoins = applyRules(c({ prCount: 1, walletBalance: 0 }), ALWAYS_FEATURES).unlocked;
    expect(noCoins.has("achievements")).toBe(true);
    expect(noCoins.has("store")).toBe(false);

    const withCoins = applyRules(c({ prCount: 1, walletBalance: 50 }), ALWAYS_FEATURES).unlocked;
    expect(withCoins.has("store")).toBe(true);
  });

  it("progress_advanced unlocks on time-in-app alone (7 days, 0 sessions)", () => {
    const { unlocked } = applyRules(c({ daysSinceFirstRun: 7 }), ALWAYS_FEATURES);
    expect(unlocked.has("progress_advanced")).toBe(true);
  });

  it("tier is 'full' only when every full-tier feature is unlocked", () => {
    const almost = applyRules(c({ finishedSessions: 4, chatMessagesSent: 0 }), ALWAYS_FEATURES).unlocked;
    expect(almost.has("insights")).toBe(true);
    expect(almost.has("voice_chat")).toBe(false);
    expect(deriveTier(almost)).toBe("established");

    const everything = applyRules(
      c({ finishedSessions: 20, activeDays: 20, prCount: 5, achievementCount: 5, walletBalance: 100, chatMessagesSent: 20, daysSinceFirstRun: 40 }),
      ALWAYS_FEATURES,
    ).unlocked;
    expect([...everything].sort()).toEqual([...ALL_FEATURES].sort());
    expect(deriveTier(everything)).toBe("full");
  });

  it("unlocks are monotonic — a lower counter never revokes", () => {
    const high = applyRules(c({ finishedSessions: 5 }), ALWAYS_FEATURES).unlocked;
    const afterRegression = applyRules(zero, high);
    for (const f of high) expect(afterRegression.unlocked.has(f)).toBe(true);
    expect(afterRegression.newlyUnlocked).toEqual([]);
  });

  it("nextUnlock points at the closest locked feature with a real distance", () => {
    const next = computeNextUnlock(zero, new Set(ALWAYS_FEATURES));
    expect(next).not.toBeNull();
    expect(["body_map", "progress_basic"]).toContain(next!.feature);
    expect(next!.progress).toEqual({ current: 0, target: 1 });
    expect(typeof next!.requirement).toBe("string");
  });

  it("nextUnlock is null when everything is unlocked", () => {
    expect(computeNextUnlock(zero, new Set(ALL_FEATURES))).toBeNull();
  });
});
