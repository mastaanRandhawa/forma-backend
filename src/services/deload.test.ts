import { describe, it, expect } from "vitest";
import { evaluateDeloadSignals } from "./deload.js";

const now = Date.parse("2026-06-01T12:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86_400_000);

const session = (d: number, vol: number) => ({ startedAt: daysAgo(d), totalVolumeKg: vol });

describe("evaluateDeloadSignals", () => {
  it("quiet baseline → no deload", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(6, 9000), session(4, 9500), session(2, 10000)],
      lastDeloadAt: null,
      checkins: [],
      totalCompletedSessions: 3,
    });
    expect(r.deload).toBe(false);
    expect(r.rule).toBe("none");
  });

  it("3+ sessions of strictly declining volume → deload", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(8, 12000), session(6, 11000), session(4, 9800), session(2, 8500)],
      lastDeloadAt: null,
      checkins: [],
      totalCompletedSessions: 12,
    });
    expect(r.deload).toBe(true);
    expect(r.rule).toBe("declining_volume_3+_sessions → deload");
  });

  it("mid-deload-week (audit < 7d old) → holds deload on", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(2, 9000)],
      lastDeloadAt: daysAgo(3),
      checkins: [],
      totalCompletedSessions: 20,
    });
    expect(r.deload).toBe(true);
    expect(r.rule).toBe("deload_audit<7d → hold");
  });

  it("within 4-week cooldown → declining volume does NOT re-trigger", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(8, 12000), session(6, 11000), session(4, 9000)],
      lastDeloadAt: daysAgo(14),
      checkins: [],
      totalCompletedSessions: 20,
    });
    expect(r.deload).toBe(false);
  });

  it("4 weeks since last deload with training history → deload", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(40, 9000), session(20, 9500), session(3, 10000)],
      lastDeloadAt: daysAgo(30),
      checkins: [],
      totalCompletedSessions: 15,
    });
    expect(r.deload).toBe(true);
    expect(r.rule).toBe("4_weeks_since_deload → deload");
  });

  it("3+ rough recovery check-ins in a week → deload", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(2, 9000)],
      lastDeloadAt: null,
      checkins: [
        { recordedAt: daysAgo(1), fatigue: 4, soreness: 2 },
        { recordedAt: daysAgo(3), fatigue: 5, soreness: 3 },
        { recordedAt: daysAgo(5), fatigue: 2, soreness: 4 },
      ],
      totalCompletedSessions: 9,
    });
    expect(r.deload).toBe(true);
    expect(r.rule).toBe("low_recovery_checkins_3+ → deload");
  });

  it("new user (little history) → time trigger stays silent", () => {
    const r = evaluateDeloadSignals({
      now,
      sessions: [session(30, 9000), session(2, 9500)],
      lastDeloadAt: null,
      checkins: [],
      totalCompletedSessions: 4,
    });
    expect(r.deload).toBe(false);
  });
});
