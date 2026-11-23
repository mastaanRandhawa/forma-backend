import { describe, expect, it } from "vitest";
import {
  addWeeks,
  computeStreak,
  localDate,
  pledgePayout,
  rankFor,
  shieldsToSpend,
  weekCounts,
  weekOf,
  weekday,
  weeklyDeals,
  workoutCoins,
} from "./rewards-rules.js";

const THIS = "2026-11-16"; // a Monday
/** counts oldest → newest, the last entry is this week */
const weeks = (counts: number[]) => new Map(counts.map((n, i) => [addWeeks(THIS, i - (counts.length - 1)), n] as const));
const streak = (counts: number[], shielded: string[] = []) => computeStreak({ counts: weeks(counts), thisWeek: THIS, target: 3, shielded: new Set(shielded) });

describe("local weeks", () => {
  it("weeks start on Monday", () => {
    expect(weekOf("2026-11-22")).toBe("2026-11-16"); // Sunday
    expect(weekOf("2026-11-16")).toBe("2026-11-16");
    expect(weekday("2026-11-18")).toBe(2);
  });
  it("uses the user's timezone, not UTC", () => {
    // Sunday 6pm in Vancouver is already Monday in UTC
    const d = new Date("2026-11-23T02:00:00Z");
    expect(localDate(d, "America/Vancouver")).toBe("2026-11-22");
    expect(weekOf(localDate(d, "America/Vancouver"))).toBe("2026-11-16");
    expect(weekOf(localDate(d, "UTC"))).toBe("2026-11-23");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(localDate(new Date("2026-11-23T02:00:00Z"), "Not/AZone")).toBe("2026-11-23");
  });
  it("counts sessions per local week", () => {
    const m = weekCounts([new Date("2026-11-17T12:00:00Z"), new Date("2026-11-23T02:00:00Z")], "America/Vancouver");
    expect(m.get("2026-11-16")).toBe(2);
  });
});

describe("weekly streak", () => {
  it("new user has no streak", () => expect(streak([0, 0, 0]).weeks).toBe(0));
  it("counts this week only once it's hit", () => {
    expect(streak([3, 3, 3, 1]).weeks).toBe(3);
    expect(streak([3, 3, 3, 3]).weeks).toBe(4);
  });
  it("forgives one missed week", () => {
    const s = streak([3, 3, 1, 3, 0]);
    expect(s.weeks).toBe(3);
    expect(s.passReady).toBe(false);
  });
  it("breaks on a second miss within four weeks", () => {
    const s = streak([3, 3, 1, 3, 1, 3, 0]);
    expect(s.weeks).toBe(2);
    expect(s.brokeAt).toBe(3);
  });
  it("forgives misses four or more weeks apart", () => expect(streak([3, 1, 3, 3, 3, 1, 3, 0]).weeks).toBe(5));
  it("missing weeks (no sessions at all) count as misses", () => {
    // gaps are absent from the map entirely, not zero rows
    const counts = new Map([[addWeeks(THIS, -1), 3], [addWeeks(THIS, -4), 3], [addWeeks(THIS, -5), 3]]);
    expect(computeStreak({ counts, thisWeek: THIS, target: 3, shielded: new Set() }).weeks).toBe(1);
  });
  it("a shielded week doesn't break the streak or use the free pass", () => {
    const s = streak([3, 3, 0, 3, 0, 3, 0], [addWeeks(THIS, -4)]);
    expect(s.weeks).toBe(4);
  });
  it("ignores weeks before training started", () => expect(streak([0, 0, 0, 3, 3, 0]).weeks).toBe(2));
});

describe("shields", () => {
  it("spends a shield on a break that hides an older run", () => {
    const input = { counts: weeks([3, 3, 3, 0, 3, 0, 0]), thisWeek: THIS, target: 3, shielded: new Set<string>() };
    // last week missed (free pass), 3 weeks ago missed → breaks; a shield there saves the 3 older weeks
    expect(computeStreak(input).weeks).toBe(1);
    const spend = shieldsToSpend(input, 2);
    expect(spend).toEqual([addWeeks(THIS, -3)]);
    expect(computeStreak({ ...input, shielded: new Set(spend) }).weeks).toBe(4);
  });
  it("doesn't spend when nothing older is worth saving", () => {
    expect(shieldsToSpend({ counts: weeks([0, 0, 1, 3, 0, 0]), thisWeek: THIS, target: 3, shielded: new Set() }, 2)).toEqual([]);
  });
  it("doesn't spend without shields", () => {
    expect(shieldsToSpend({ counts: weeks([3, 3, 3, 0, 3, 0, 0]), thisWeek: THIS, target: 3, shielded: new Set() }, 0)).toEqual([]);
  });
});

describe("rank", () => {
  it("earns XP from sessions and target weeks only", () => {
    const r = rankFor(weeks([3, 3, 3, 3]), THIS, 3);
    expect(r.xp).toBe(4 * 300 + 4 * 150);
    expect(r.title).toBe("Committed");
  });
  it("starts at Rookie", () => expect(rankFor(new Map(), THIS, 3).title).toBe("Rookie"));
});

describe("workout coins", () => {
  it("pays for working sets, capped", () => {
    expect(workoutCoins({ workingSets: 10, prs: 0, earlierToday: 0, gapDays: 1 }).base).toBe(90);
    expect(workoutCoins({ workingSets: 50, prs: 0, earlierToday: 0, gapDays: 1 }).base).toBe(120);
  });
  it("stops paying base coins after two sessions in a day", () => {
    expect(workoutCoins({ workingSets: 10, prs: 0, earlierToday: 2, gapDays: 0 }).base).toBe(0);
  });
  it("caps PR coins at three", () => expect(workoutCoins({ workingSets: 0, prs: 7, earlierToday: 0, gapDays: 1 }).prs).toBe(150));
  it("pays a comeback bonus after a week off, not for a first session", () => {
    expect(workoutCoins({ workingSets: 0, prs: 0, earlierToday: 0, gapDays: 9 }).comeback).toBe(60);
    expect(workoutCoins({ workingSets: 0, prs: 0, earlierToday: 0, gapDays: null }).comeback).toBe(0);
  });
});

describe("pledges and deals", () => {
  it("a kept pledge returns stake + 50%", () => expect(pledgePayout(100)).toBe(150));
  it("deals are stable per user and week, and discounted", () => {
    const cat = { a: { price: 100 }, b: { price: 200 }, c: { price: 300 }, d: { price: 400 }, free: { price: 0 } };
    const one = weeklyDeals("u1", THIS, cat, []);
    expect(one).toHaveLength(3);
    expect(weeklyDeals("u1", THIS, cat, [])).toEqual(one);
    expect(one.every((d) => d.id !== "free" && d.dealPrice === Math.round(d.price * 0.75))).toBe(true);
    // buying one doesn't reshuffle the others
    expect(weeklyDeals("u1", THIS, cat, [one[0].id]).map((d) => d.id)).toEqual(one.map((d) => d.id));
  });
});
