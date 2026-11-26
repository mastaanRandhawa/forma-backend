import { describe, expect, it } from "vitest";
import { computeNamedPrescription, type RuleTemplate, type SessionSets } from "./progression-rules.js";

const sets = (weight: number, reps: number[], extra: Partial<{ rpe: number; durationSeconds: number }> = {}): SessionSets => ({
  sets: reps.map((r) => ({ weightKg: weight, reps: r, rpe: extra.rpe ?? null, durationSeconds: extra.durationSeconds ?? null })),
});
const t5x5: RuleTemplate = { targetSets: 5, targetRepsMin: 5, targetRepsMax: 5, targetWeightKg: 60 };
const metric = { unit: "metric" as const };

describe("linear", () => {
  it("starts from the template weight with no history", () => {
    const r = computeNamedPrescription("linear", t5x5, [], metric);
    expect(r.targetWeightKg).toBe(60);
    expect(r.rule).toBe("linear: no_history → template_target");
  });
  it("adds the increment when every set hit the reps", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 5, 5, 5])], metric);
    expect(r.targetWeightKg).toBe(102.5);
    expect(r.targetReps).toBe(5);
    expect(r.note).toContain("add 2.5 kg");
  });
  it("uses a custom increment", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 5, 5, 5])], { ...metric, incrementKg: 5 });
    expect(r.targetWeightKg).toBe(105);
  });
  it("repeats the weight after a miss", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 5, 4, 3])], metric);
    expect(r.targetWeightKg).toBe(100);
    expect(r.rule).toBe("linear: missed_reps → repeat");
  });
  it("drops 10% after three misses at the same weight", () => {
    const miss = sets(100, [5, 5, 4, 3, 3]);
    const r = computeNamedPrescription("linear", t5x5, [miss, miss, miss], metric);
    expect(r.targetWeightKg).toBe(90);
    expect(r.rule).toBe("linear: three_stalls → -10%");
  });
  it("does not deload when the misses were at different weights", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 4, 3, 3]), sets(100, [5, 5, 5, 4, 3]), sets(97.5, [5, 5, 5, 5, 4])], metric);
    expect(r.targetWeightKg).toBe(100);
  });
  it("needs all the planned sets, not just good reps on fewer sets", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 5])], metric);
    expect(r.targetWeightKg).toBe(100);
  });
  it("rounds imperial increments to real plates (5 lb)", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 5, 5, 5])], { unit: "imperial" });
    // 100 kg is 220.5 lb; plus 5 lb is 225.5 lb, which snaps to the 225 lb step
    expect(Math.round((r.targetWeightKg! * 2.2046226218) * 2) / 2).toBe(225);
  });
});

describe("greyskull", () => {
  const t: RuleTemplate = { targetSets: 3, targetRepsMin: 5, targetRepsMax: 5, targetWeightKg: 60 };
  it("adds the increment when the AMRAP set reaches 5", () => {
    const r = computeNamedPrescription("greyskull", t, [sets(80, [5, 5, 7])], metric);
    expect(r.targetWeightKg).toBe(82.5);
    expect(r.rule).toBe("greyskull: amrap_5+ → +increment");
  });
  it("adds double when the AMRAP set reaches 10", () => {
    const r = computeNamedPrescription("greyskull", t, [sets(80, [5, 5, 11])], metric);
    expect(r.targetWeightKg).toBe(85);
    expect(r.rule).toBe("greyskull: amrap_10+ → +2×increment");
  });
  it("drops 10% when the AMRAP set is under 5", () => {
    const r = computeNamedPrescription("greyskull", t, [sets(80, [5, 5, 3])], metric);
    expect(r.targetWeightKg).toBe(72.5);
    expect(r.rule).toBe("greyskull: amrap_<5 → -10%");
  });
  it("treats a missed standard set as a stall even if the AMRAP set was big", () => {
    const r = computeNamedPrescription("greyskull", t, [sets(80, [5, 4, 12])], metric);
    expect(r.targetWeightKg).toBe(72.5);
  });
});

describe("double progression", () => {
  const t: RuleTemplate = { targetSets: 3, targetRepsMin: 8, targetRepsMax: 12, targetWeightKg: 20 };
  it("holds the weight and adds a rep while below the top", () => {
    const r = computeNamedPrescription("double_progression", t, [sets(20, [10, 9, 8])], metric);
    expect(r.targetWeightKg).toBe(20);
    expect(r.targetReps).toBe(9); // lowest was 8 → aim for 9 on every set
  });
  it("adds weight and resets to the bottom once every set reaches the top", () => {
    const r = computeNamedPrescription("double_progression", t, [sets(20, [12, 12, 12])], metric);
    expect(r.targetWeightKg).toBe(22.5);
    expect(r.targetReps).toBe(8);
    expect(r.rule).toContain("reset_reps");
  });
  it("never targets more than the top of the range", () => {
    const r = computeNamedPrescription("double_progression", t, [sets(20, [12, 12, 11])], metric);
    expect(r.targetReps).toBe(12);
    expect(r.targetWeightKg).toBe(20);
  });
  it("starts at the bottom of the range with no history", () => {
    expect(computeNamedPrescription("double_progression", t, [], metric).targetReps).toBe(8);
  });
});

describe("added time", () => {
  const t: RuleTemplate = { targetSets: 3, targetRepsMin: null, targetRepsMax: null, targetWeightKg: null, targetDurationSec: 40 };
  it("starts at the target with no history", () => {
    expect(computeNamedPrescription("added_time", t, [], metric).targetDurationSec).toBe(40);
  });
  it("adds 5 s when every set reached the target", () => {
    const r = computeNamedPrescription("added_time", t, [{ sets: [40, 42, 45].map((d) => ({ weightKg: 0, reps: 0, rpe: null, durationSeconds: d })) }], metric);
    expect(r.targetDurationSec).toBe(45);
  });
  it("repeats the target when a set fell short", () => {
    const r = computeNamedPrescription("added_time", t, [{ sets: [40, 35].map((d) => ({ weightKg: 0, reps: 0, rpe: null, durationSeconds: d })) }], metric);
    expect(r.targetDurationSec).toBe(40);
    expect(r.rule).toBe("added_time: missed_40s → repeat");
  });
  it("uses a custom number of seconds", () => {
    const r = computeNamedPrescription("added_time", t, [{ sets: [{ weightKg: 0, reps: 0, rpe: null, durationSeconds: 60 }] }], { ...metric, incrementSec: 10 });
    expect(r.targetDurationSec).toBe(70);
  });
});

describe("deload", () => {
  it("takes 10% off and targets the bottom of the range, whatever the rule", () => {
    const r = computeNamedPrescription("linear", t5x5, [sets(100, [5, 5, 5, 5, 5])], { ...metric, deload: true });
    expect(r.targetWeightKg).toBe(90);
    expect(r.rule).toBe("linear: deload_week → -10%");
  });
});
