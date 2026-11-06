import { describe, expect, it } from "vitest";
import {
  clockFor,
  daysToFreeze,
  daysToHold,
  localDay,
  plannedDays,
  repairOption,
  shiftDay,
  streakLength,
  todayCounts,
} from "./streak.js";
import {
  bundlePrice,
  CONSUMABLES,
  currentPrice,
  dealsFor,
  defaultChallengeSlots,
  STREAK_MILESTONES,
  STREAK_REPAIR,
  weekTargetCoins,
  workoutCoins,
} from "../data/economy.js";

const TODAY = "2026-11-11"; // a Wednesday
const EVERY_DAY = 7;
/** Days counted back from today: days(0, 1, 2) is today and the two before it. */
const days = (...back: number[]) => new Set(back.map((n) => shiftDay(TODAY, -n)));
const none = new Set<string>();
// how far back those weekdays are: 3–9 days is last Sunday to last Monday
const LAST_WEEK = { mon: 9, tue: 8, wed: 7, thu: 6, fri: 5, sat: 4, sun: 3 };
const WEEK_BEFORE = { mon: 16, tue: 15, wed: 14, thu: 13, fri: 12, sat: 11, sun: 10 };

describe("streakLength", () => {
  it("counts trained days up to today", () => {
    expect(streakLength(days(0, 1, 2), none, TODAY, EVERY_DAY)).toBe(3);
  });
  it("doesn't break just because today isn't trained yet", () => {
    expect(streakLength(days(1, 2, 3), none, TODAY, EVERY_DAY)).toBe(3);
  });
  it("is broken by a missed day", () => {
    expect(streakLength(days(2, 3, 4), none, TODAY, EVERY_DAY)).toBe(0);
  });
  it("a protected day bridges the run without adding to it", () => {
    expect(streakLength(days(2, 3, 4), days(1), TODAY, EVERY_DAY)).toBe(3);
    expect(streakLength(days(0, 2, 3), days(1), TODAY, EVERY_DAY)).toBe(3);
  });
});

describe("the plan", () => {
  // the same table is in frontend/tests/e2e/economy-offline.spec.ts, and the two must agree
  it("is the weekly target, then the picked weekdays, then the default", () => {
    expect(plannedDays(5, [1, 3, 5])).toBe(5);
    expect(plannedDays(null, [1, 3, 5])).toBe(3);
    expect(plannedDays(undefined, [1, 2, 3, 4])).toBe(4);
    expect(plannedDays(null, [])).toBe(3);
    expect(plannedDays(0)).toBe(3);
    expect(plannedDays(9)).toBe(7);
  });

  it("a five-day week holds a streak on no freezes at all", () => {
    const weekdays = (w: typeof LAST_WEEK) => [w.mon, w.tue, w.wed, w.thu, w.fri];
    const trained = days(...weekdays(WEEK_BEFORE), ...weekdays(LAST_WEEK), 1, 2);
    expect(streakLength(trained, none, TODAY, 5)).toBe(12);
    expect(daysToFreeze(trained, none, TODAY, 2, 5)).toEqual([]);
    expect(repairOption(trained, none, TODAY, 5)).toBeNull();
  });

  it("a three-day week holds on any three days, not fixed ones", () => {
    const trained = days(
      WEEK_BEFORE.mon, WEEK_BEFORE.wed, WEEK_BEFORE.fri, // Mon · Wed · Fri
      LAST_WEEK.tue, LAST_WEEK.sat, LAST_WEEK.sun, // moved around
      1, // Tuesday this week
    );
    expect(streakLength(trained, none, TODAY, 3)).toBe(7);
  });

  it("a miss is the day the week's target stops being reachable", () => {
    // Monday trained, then four days off: the fifth day off leaves 2 sessions of 3 at most
    const trained = days(WEEK_BEFORE.mon, WEEK_BEFORE.tue, WEEK_BEFORE.wed, WEEK_BEFORE.thu, LAST_WEEK.mon);
    const nextDay = LAST_WEEK.fri;
    expect(streakLength(trained, none, shiftDay(TODAY, -nextDay), 3)).toBe(5);
    expect(streakLength(trained, none, shiftDay(TODAY, -nextDay + 1), 3)).toBe(5); // Saturday: Fri was rest 4
    expect(streakLength(trained, none, shiftDay(TODAY, -nextDay + 2), 3)).toBe(0); // Sunday: Sat was a miss
  });

  it("each Monday brings the week's rest days back", () => {
    // Sat + Sun off, then Mon + Tue off: four in a row, but only two in each week
    const trained = days(LAST_WEEK.mon, LAST_WEEK.tue, LAST_WEEK.wed, LAST_WEEK.thu, LAST_WEEK.fri);
    expect(streakLength(trained, none, TODAY, 5)).toBe(5);
  });

  it("every day off is a miss on a seven-day plan", () => {
    expect(streakLength(days(2, 3, 4), none, TODAY, 7)).toBe(0);
    expect(streakLength(days(2, 3, 4), none, TODAY, 6)).toBe(3);
  });

  it("days before training started don't use up the week's rest", () => {
    // a first ever session on Monday this week, on a six-day plan
    expect(streakLength(days(1, 2), none, TODAY, 6)).toBe(2);
    // started last Thursday: Friday off is fine, as the Mon–Wed before it don't count
    const started = days(LAST_WEEK.thu, LAST_WEEK.sat, LAST_WEEK.sun);
    expect(streakLength(started, none, shiftDay(TODAY, -2), 6)).toBe(3);
  });

  it("a new run after a miss gets its rest days back for the week", () => {
    // five-day plan: Mon + Tue rest, Wed a miss, then Thu, Sat, Sun with Friday off
    const trained = days(LAST_WEEK.thu, LAST_WEEK.sat, LAST_WEEK.sun, WEEK_BEFORE.fri, WEEK_BEFORE.thu, WEEK_BEFORE.wed);
    expect(streakLength(trained, none, shiftDay(TODAY, -2), 5)).toBe(3);
  });

  it("a protected day doesn't use up the week's rest", () => {
    // five-day plan, now Sunday: Mon–Wed trained, Thu protected, Fri + Sat are the two rest days
    const sunday = shiftDay(TODAY, -3);
    expect(streakLength(days(LAST_WEEK.mon, LAST_WEEK.tue, LAST_WEEK.wed), days(LAST_WEEK.thu), sunday, 5)).toBe(3);
  });

  it("only warns about today when skipping it would cost the streak", () => {
    expect(todayCounts(days(1, 2, 3), none, TODAY, 7)).toBe(true);
    expect(todayCounts(days(1, 2, 3), none, TODAY, 5)).toBe(false);
    expect(todayCounts(days(0, 1, 2), none, TODAY, 7)).toBe(false);
  });

});

describe("changing the plan", () => {
  const WED = shiftDay(TODAY, -7);
  const THU = shiftDay(TODAY, -6);
  const FRI = shiftDay(TODAY, -5);
  const SAT = shiftDay(TODAY, -4);

  it("saves what a stricter plan would call misses in the current run, and no more", () => {
    // three-day plan, now Saturday: Mon trained, then four rest days. A six-day plan allows one
    expect(daysToHold(days(9), none, SAT, 3, 6)).toEqual([WED, THU, FRI]);
    expect(streakLength(days(9), new Set([WED, THU, FRI]), SAT, 6)).toBe(1);
  });

  it("doesn't free up rest: what's been taken this week still counts", () => {
    // now Friday, Mon trained, Tue–Thu off. Three days fit a three-day plan, and only two of them
    // fit a five-day one, so one is saved and there's no rest left this week
    const held = new Set(daysToHold(days(9), none, FRI, 3, 5));
    expect([...held]).toEqual([THU]);
    expect(streakLength(days(9), held, FRI, 5)).toBe(1);
    expect(streakLength(days(9), held, SAT, 5)).toBe(0); // Friday off is now a miss
  });

  it("can't revive a streak that's already broken", () => {
    expect(daysToHold(days(2, 3, 4), none, TODAY, 7, 5)).toEqual([]);
    expect(daysToHold(days(5, 6, 7), none, TODAY, 7, 6)).toEqual([]);
  });

  it("saves nothing when the new plan already allows the run, or there's no run", () => {
    expect(daysToHold(days(2, 3, 4), none, TODAY, 5, 3)).toEqual([]);
    expect(daysToHold(days(2, 3, 4), none, TODAY, 5, 5)).toEqual([]);
    expect(daysToHold(none, none, TODAY, 3, 7)).toEqual([]);
  });

  it("keeps a run even when a lighter plan would cut it short", () => {
    // now Monday. Five-day plan: Mon + Tue rest, Wed a miss, Thu trained, Fri + Sat rest, Sun trained
    const monday = shiftDay(TODAY, -2);
    const trained = days(WEEK_BEFORE.sun, LAST_WEEK.thu, LAST_WEEK.sun);
    expect(streakLength(trained, none, monday, 5)).toBe(2);
    // on four days that week's rest runs out by Thursday, so Fri + Sat would miss
    expect(streakLength(trained, none, monday, 4)).toBe(1);
    const held = daysToHold(trained, none, monday, 5, 4);
    expect(held).toEqual([FRI, SAT]);
    expect(streakLength(trained, new Set(held), monday, 4)).toBeGreaterThanOrEqual(2);
  });
});

describe("daysToFreeze", () => {
  it("covers a missed day on a real streak", () => {
    expect(daysToFreeze(days(2, 3, 4), none, TODAY, 1, EVERY_DAY)).toEqual([shiftDay(TODAY, -1)]);
  });
  it("covers several days oldest first", () => {
    expect(daysToFreeze(days(3, 4, 5), none, TODAY, 2, EVERY_DAY)).toEqual([shiftDay(TODAY, -2), shiftDay(TODAY, -1)]);
  });
  it("covers the day just missed even once today is trained", () => {
    expect(daysToFreeze(days(0, 2, 3, 4), none, TODAY, 1, EVERY_DAY)).toEqual([shiftDay(TODAY, -1)]);
  });
  it("does nothing when yesterday was trained", () => {
    expect(daysToFreeze(days(1, 2, 3), none, TODAY, 2, EVERY_DAY)).toEqual([]);
  });
  it("won't spend freezes that can't cover the whole gap", () => {
    expect(daysToFreeze(days(4, 5, 6), none, TODAY, 2, EVERY_DAY)).toEqual([]);
  });
  it("won't spend a freeze on a tiny streak", () => {
    expect(daysToFreeze(days(2, 3), none, TODAY, 2, EVERY_DAY)).toEqual([]);
  });
  it("needs a freeze", () => {
    expect(daysToFreeze(days(2, 3, 4), none, TODAY, 0, EVERY_DAY)).toEqual([]);
  });
  it("is never spent on a rest day", () => {
    expect(daysToFreeze(days(2, 3, 4), none, TODAY, 2, 5)).toEqual([]);
  });
  it("covers only the days the plan doesn't excuse", () => {
    // five-day plan, off since Monday, now Friday: Mon + Tue are rest, Wed + Thu are misses
    const friday = shiftDay(TODAY, -5);
    const misses = [shiftDay(TODAY, -7), shiftDay(TODAY, -6)];
    expect(daysToFreeze(days(10, 11, 12), none, friday, 2, 5)).toEqual(misses);
    expect(daysToFreeze(days(10, 11, 12), none, friday, 1, 5)).toEqual([]);
    expect(streakLength(days(10, 11, 12), new Set(misses), friday, 5)).toBe(3);
  });
});

describe("repairOption", () => {
  it("offers to cover a gap right behind today", () => {
    expect(repairOption(days(2, 3, 4), none, TODAY, EVERY_DAY)).toEqual({ days: [shiftDay(TODAY, -1)], restoresTo: 3 });
  });
  it("joins the runs when training has already restarted", () => {
    expect(repairOption(days(0, 2, 3, 4), none, TODAY, EVERY_DAY)).toEqual({ days: [shiftDay(TODAY, -1)], restoresTo: 4 });
  });
  it("refuses a gap longer than 3 days", () => {
    expect(repairOption(days(5, 6, 7), none, TODAY, EVERY_DAY)).toBeNull();
  });
  it("refuses when there was no real streak to save", () => {
    expect(repairOption(days(2, 3), none, TODAY, EVERY_DAY)).toBeNull();
  });
  it("refuses a gap that ended too long ago", () => {
    expect(repairOption(days(0, 1, 2, 3, 5, 6, 7), none, TODAY, EVERY_DAY)).toBeNull();
  });
  it("has nothing to do on an unbroken streak of any length", () => {
    expect(repairOption(days(0, 1, 2, 3, 4, 5, 6), none, TODAY, EVERY_DAY)).toBeNull();
  });
  it("has nothing to do on a rest day", () => {
    expect(repairOption(days(2, 3, 4), none, TODAY, 5)).toBeNull();
  });
  it("counts missed training days, not days off, toward the 3-day limit", () => {
    // five-day plan, off Mon–Fri, now Saturday: two rest days and three misses
    const saturday = shiftDay(TODAY, -4);
    expect(repairOption(days(10, 11, 12), none, saturday, 5)).toEqual({
      days: [shiftDay(TODAY, -7), shiftDay(TODAY, -6), shiftDay(TODAY, -5)],
      restoresTo: 3,
    });
  });
  it("also covers what joining the runs turns into a miss", () => {
    // five-day plan, now Sunday: Mon + Tue rest, Wed a miss, Thu + Fri trained, Sat off
    const sunday = shiftDay(TODAY, -3);
    expect(repairOption(days(10, 11, 12, 6, 5), none, sunday, 5)).toEqual({
      days: [shiftDay(TODAY, -7), shiftDay(TODAY, -4)],
      restoresTo: 5,
    });
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

  // a streak needs no freezes now, so anyone training to plan reaches these
  const milestonesBy = (trainedDays: number) =>
    Object.entries(STREAK_MILESTONES).reduce((n, [at, coins]) => (trainedDays >= Number(at) ? n + coins : n), 0);

  it("streak milestones pay about 30 a week for a committed user and 15 for a casual one", () => {
    expect(milestonesBy(5 * 12) / 12).toBe(30);
    expect(milestonesBy(3 * 12) / 12).toBeCloseTo(15.4, 1);
    expect(milestonesBy(100)).toBe(660);
  });
  it("a freeze is cheap insurance: a third of a casual week, well under a repair", () => {
    const freeze = CONSUMABLES["cs-freeze"]!.price;
    expect(freeze).toBe(100);
    expect(freeze / casualWeek).toBeLessThan(0.35);
    expect(freeze).toBeLessThan(STREAK_REPAIR.price / 4);
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
