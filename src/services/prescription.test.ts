import { describe, it, expect } from "vitest";
import { computePrescription, roundToPlate, type PrescriptionTemplate } from "./prescription.js";

const tpl: PrescriptionTemplate = { targetRepsMin: 6, targetRepsMax: 8, targetWeightKg: 100 };
const metric = { unit: "metric" as const };

describe("roundToPlate", () => {
  it("snaps to 1.25 kg steps (metric)", () => {
    expect(roundToPlate(101, "metric")).toBe(101.25);
    expect(roundToPlate(102.4, "metric")).toBe(102.5);
    expect(roundToPlate(0, "metric")).toBe(0);
  });
  it("snaps to 2.5 lb steps (imperial)", () => {
    // 100 kg ≈ 220.46 lb → 220 lb → back to ~99.79 kg
    expect(roundToPlate(100, "imperial")).toBeCloseTo(99.79, 1);
  });
});

describe("computePrescription", () => {
  it("no history → template target, top of range, RPE 8", () => {
    const p = computePrescription(tpl, { lastSets: [] }, metric);
    expect(p.targetWeightKg).toBe(100);
    expect(p.targetReps).toBe(8);
    expect(p.rule).toBe("no_history → template_target");
  });

  it("no history, no template weight → bodyweight table when available", () => {
    const p = computePrescription(
      { targetRepsMin: 8, targetRepsMax: 12, targetWeightKg: null },
      { lastSets: [], bodyweightKg: 80, bodyweightFactor: 0.5 },
      metric,
    );
    expect(p.targetWeightKg).toBe(40);
    expect(p.rule).toBe("no_history → bodyweight_table");
  });

  it("all sets at top of range + RPE ≤ 7 → +5%", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 8, rpe: 7 }, { weightKg: 100, reps: 8, rpe: 7 } ] },
      metric,
    );
    expect(p.targetWeightKg).toBe(105);
    expect(p.rule).toBe("top_of_range_rpe<=7 → +5%");
  });

  it("all sets at top of range + RPE 8 → +2.5%", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 8, rpe: 8 }, { weightKg: 100, reps: 9, rpe: 8 } ] },
      metric,
    );
    expect(p.targetWeightKg).toBe(102.5);
    expect(p.rule).toBe("top_of_range_rpe<=8 → +2.5%");
  });

  it("mid-range at RPE 8–9 → hold load, chase +1 rep", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 7, rpe: 8.5 }, { weightKg: 100, reps: 7, rpe: 9 } ] },
      metric,
    );
    expect(p.targetWeightKg).toBe(100);
    expect(p.targetReps).toBe(8);
    expect(p.rule).toBe("mid_range_rpe_8-9 → hold_load_+1_rep");
  });

  it("missed the bottom of the range → back off 10%", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 5, rpe: 9 }, { weightKg: 100, reps: 4, rpe: 9.5 } ] },
      metric,
    );
    expect(p.targetWeightKg).toBe(90);
    expect(p.rule).toBe("missed_bottom_of_range → -10%");
  });

  it("RPE > 9 on 2+ sets (still in range) → back off 10%", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 6, rpe: 9.5 }, { weightKg: 100, reps: 6, rpe: 10 } ] },
      metric,
    );
    expect(p.targetWeightKg).toBe(90);
    expect(p.rule).toBe("rpe>9_on_2+_sets → -10%");
  });

  it("deload week → -10% load, bottom of range, RPE 7 — regardless of last performance", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 8, rpe: 6 } ] },
      { unit: "metric", deload: true },
    );
    expect(p.targetWeightKg).toBe(90);
    expect(p.targetReps).toBe(6);
    expect(p.targetRpe).toBe(7);
    expect(p.rule).toBe("deload_week → -10%_load_rpe<=7");
  });

  it("no RPE logged → conservative hold (never auto-progresses blind)", () => {
    const p = computePrescription(
      tpl,
      { lastSets: [ { weightKg: 100, reps: 8, rpe: null } ] },
      metric,
    );
    expect(p.targetWeightKg).toBe(100);
    expect(p.rule).toBe("mid_range_rpe_8-9 → hold_load_+1_rep");
  });
});
