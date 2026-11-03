import { describe, expect, it } from "vitest";
import { clockFor, daysToFreeze, localDay, repairOption, shiftDay, streakLength } from "./streak.js";
import { bundlePrice, currentPrice, dealsFor, defaultChallengeSlots, weekTargetCoins, workoutCoins } from "../data/economy.js";

const TODAY = "2026-11-11";
/** Days counted back from today: days(0, 1, 2) is today and the two before it. */
const days = (...back: number[]) => new Set(back.map((n) => shiftDay(TODAY, -n)));
const none = new Set<string>();

describe("streakLength", () => {
  it("counts back from today", () => {
    expect(streakLength(days(0, 1, 2), none, TODAY)).toBe(3);
  });
  it("doesn't break just because today isn't trained yet", () => {
    expect(streakLength(days(1, 2, 3), none, TODAY)).toBe(3);
  });
  it("is broken by a missed day", () => {
    expect(streakLength(days(2, 3, 4), none, TODAY)).toBe(0);
  });
  it("a protected day bridges the run without adding to it", () => {
    expect(streakLength(days(2, 3, 4), days(1), TODAY)).toBe(3);
    expect(streakLength(days(0, 2, 3), days(1), TODAY)).toBe(3);
  });
});

describe("daysToFreeze", () => {
  it("covers a missed day on a real streak", () => {
    expect(daysToFreeze(days(2, 3, 4), none, TODAY, 1)).toEqual([shiftDay(TODAY, -1)]);
  });
  it("covers several days oldest first", () => {
    expect(daysToFreeze(days(3, 4, 5), none, TODAY, 2)).toEqual([shiftDay(TODAY, -2), shiftDay(TODAY, -1)]);
  });
  it("does nothing when yesterday was trained", () => {
    expect(daysToFreeze(days(1, 2, 3), none, TODAY, 2)).toEqual([]);
  });
  it("won't spend freezes that can't cover the whole gap", () => {
    expect(daysToFreeze(days(4, 5, 6), none, TODAY, 2)).toEqual([]);
  });
  it("won't spend a freeze on a tiny streak", () => {
    expect(daysToFreeze(days(2, 3), none, TODAY, 2)).toEqual([]);
  });
  it("needs a freeze", () => {
    expect(daysToFreeze(days(2, 3, 4), none, TODAY, 0)).toEqual([]);
  });
});

describe("repairOption", () => {
  it("offers to cover a gap right behind today", () => {
    expect(repairOption(days(2, 3, 4), none, TODAY)).toEqual({ days: [shiftDay(TODAY, -1)], restoresTo: 3 });
  });
  it("joins the runs when training has already restarted", () => {
    expect(repairOption(days(0, 2, 3, 4), none, TODAY)).toEqual({ days: [shiftDay(TODAY, -1)], restoresTo: 4 });
  });
  it("refuses a gap longer than 3 days", () => {
    expect(repairOption(days(5, 6, 7), none, TODAY)).toBeNull();
  });
  it("refuses when there was no real streak to save", () => {
    expect(repairOption(days(2, 3), none, TODAY)).toBeNull();
  });
  it("refuses a gap that ended too long ago", () => {
    expect(repairOption(days(0, 1, 2, 3, 5, 6, 7), none, TODAY)).toBeNull();
  });
  it("has nothing to do on an unbroken streak of any length", () => {
    expect(repairOption(days(0, 1, 2, 3, 4, 5, 6), none, TODAY)).toBeNull();
  });
});

describe("clock", () => {
  it("works out the local day from the UTC offset", () => {
    const at = new Date("2026-11-02T23:30:00Z");
    expect(localDay(at, 0)).toBe("2026-11-02");
    expect(localDay(at, 330)).toBe("2026-11-03");
    expect(localDay(at, -480)).toBe("2026-11-02");
  });
  it("starts the week on Monday, in the same format as the client", () => {
    expect(clockFor(0, new Date("2026-11-08T12:00:00Z")).week).toBe("w2026-11-02"); // Sunday
    expect(clockFor(0, new Date("2026-11-02T12:00:00Z")).week).toBe("w2026-11-02"); // Monday
    expect(clockFor(0, new Date("2026-11-09T00:00:00Z")).week).toBe("w2026-11-09");
  });
  it("places the day boundary at local midnight", () => {
    const clock = clockFor(-300, new Date("2026-11-02T12:00:00Z"));
    expect(clock.dayStart.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("earn rules", () => {
  it("refuses an empty or rushed workout", () => {
    expect(workoutCoins(2, 3600)).toBeNull();
    expect(workoutCoins(10, 299)).toBeNull();
  });
  it("pays 30 + 2 per working set, up to 60", () => {
    expect(workoutCoins(3, 300)).toBe(36);
    expect(workoutCoins(10, 3000)).toBe(50);
    expect(workoutCoins(40, 3000)).toBe(60);
  });
  it("pays less for a lower weekly target, and clamps it", () => {
    expect(weekTargetCoins(1)).toBe(50);
    expect(weekTargetCoins(3)).toBe(75);
    expect(weekTargetCoins(5)).toBe(125);
    expect(weekTargetCoins(7)).toBe(125);
  });
});

describe("balance", () => {
  // the earn-rate model from docs/COIN_ECONOMY.md, so a rule change that breaks it fails here
  const committedWeek =
    5 * workoutCoins(16, 3000)! + 2 * 25 + 7 * 5 + 5 * 10 + 6 * 10 + 3 * 10 + weekTargetCoins(5) + 2 * 60;
  const casualWeek = 3 * workoutCoins(10, 3000)! + 12 + 4 * 5 + 10 + 2 * 10 + 56 + 27;

  it("a committed user earns about 800 a week and a casual one about 300", () => {
    expect(committedWeek).toBe(770);
    expect(casualWeek).toBe(295);
  });
  it("a committed user can buy a mid-tier item about weekly", () => {
    for (const id of ["fx-aurora", "l-nebula", "fr-flame", "ps-drill", "cl-fireworks"]) {
      expect(currentPrice(id, "w2000-01-03")).toBeLessThanOrEqual(committedWeek + 50);
    }
  });
  it("a committed user can buy a top item in about a month, and not much faster", () => {
    const weeks = 3000 / committedWeek;
    expect(weeks).toBeGreaterThan(3);
    expect(weeks).toBeLessThan(4.5);
  });
});

describe("rotation", () => {
  it("is stable within a week and changes across weeks", () => {
    expect(defaultChallengeSlots("w2026-11-02")).toEqual(defaultChallengeSlots("w2026-11-02"));
    const many = new Set(
      Array.from({ length: 8 }, (_, i) => defaultChallengeSlots(`w2026-${String(i + 1).padStart(2, "0")}-01`).join()),
    );
    expect(many.size).toBeGreaterThan(1);
    expect(defaultChallengeSlots("w2026-11-02")).toHaveLength(3);
  });
  it("discounts three items by 25%", () => {
    const deals = dealsFor("w2026-11-02");
    expect(deals).toHaveLength(3);
    for (const d of deals) {
      expect(d.price).toBeLessThan(d.was);
      expect(d.price / d.was).toBeCloseTo(0.75, 1);
      expect(currentPrice(d.itemId, "w2026-11-02")).toBe(d.price);
    }
  });
  it("prices a bundle on what the buyer doesn't own", () => {
    expect(bundlePrice("bn-neon", [])).toBe(735);
    expect(bundlePrice("bn-neon", ["fn-mono"])).toBe(675);
    expect(bundlePrice("bn-neon", ["fx-scanlines", "t-terminal", "fn-mono", "rs-arcade"])).toBe(0);
  });
});
