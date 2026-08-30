import { prisma } from "../prisma.js";

/**
 * Progressive-overload prescription (§2.1). Deterministic, unit-tested, no LLM.
 *
 * Given the athlete's most recent completed working sets for an exercise and the
 * template's rep range, decide today's target weight / reps / RPE. The AI layer
 * may only *explain* this output — never choose the numbers (§4).
 */

export type Unit = "metric" | "imperial";

const LB_PER_KG = 2.2046226218;

/** Round a load to the smallest real barbell increment for the user's unit. */
export function roundToPlate(weightKg: number, unit: Unit): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return 0;
  if (unit === "imperial") {
    const lb = weightKg * LB_PER_KG;
    const snapped = Math.round(lb / 2.5) * 2.5; // 2.5 lb steps
    return Math.round((snapped / LB_PER_KG) * 100) / 100;
  }
  const snapped = Math.round(weightKg / 1.25) * 1.25; // 1.25 kg steps
  return Math.round(snapped * 100) / 100;
}

export interface WorkingSet {
  weightKg: number;
  reps: number;
  rpe: number | null;
}

export interface PrescriptionTemplate {
  targetRepsMin: number | null;
  targetRepsMax: number | null;
  targetWeightKg: number | null;
}

export interface PrescriptionInputs {
  /** Most recent completed working sets for this exercise (any order). */
  lastSets: WorkingSet[];
  /** Fallback when there is no logged history and no template weight. */
  bodyweightKg?: number | null;
  bodyweightFactor?: number | null; // e.g. 0.4 for a row, 0.75 for a squat
}

export interface PrescriptionOptions {
  unit: Unit;
  deload?: boolean;
}

export interface Prescription {
  targetWeightKg: number | null;
  targetReps: number | null;
  targetRpe: number | null;
  note: string;
  /** Which rule branch fired — stored verbatim on the audit row. */
  rule: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function fmtWeight(kg: number, unit: Unit): string {
  return unit === "imperial" ? `${Math.round(kg * LB_PER_KG)} lb` : `${round1(kg)} kg`;
}

/**
 * Pure core. `template` + observed `inputs` → today's prescription.
 * No I/O; every branch is covered by prescription.test.ts.
 */
export function computePrescription(
  template: PrescriptionTemplate,
  inputs: PrescriptionInputs,
  opts: PrescriptionOptions,
): Prescription {
  const repMin = template.targetRepsMin ?? 8;
  const repMax = template.targetRepsMax ?? template.targetRepsMin ?? repMin + 2;
  const working = inputs.lastSets.filter((s) => s.weightKg > 0 && s.reps > 0);

  // ── no history ───────────────────────────────────────────────────────────
  if (working.length === 0) {
    let base = template.targetWeightKg ?? null;
    let rule = "no_history → template_target";
    if (base == null && inputs.bodyweightKg && inputs.bodyweightFactor) {
      base = inputs.bodyweightKg * inputs.bodyweightFactor;
      rule = "no_history → bodyweight_table";
    }
    return {
      targetWeightKg: base != null ? roundToPlate(base, opts.unit) : null,
      targetReps: repMax,
      targetRpe: 8,
      note:
        base != null
          ? `First logged session — start around ${fmtWeight(roundToPlate(base, opts.unit), opts.unit)} and we calibrate from there.`
          : "No history yet — log honest weights today and I'll prescribe from next session.",
      rule,
    };
  }

  const lastWeight = Math.max(...working.map((s) => s.weightKg));
  const atTopWeight = working.filter((s) => s.weightKg >= lastWeight - 1e-6);
  const repsAtTop = atTopWeight.map((s) => s.reps);
  const minReps = Math.min(...working.map((s) => s.reps));
  const rpes = working.map((s) => s.rpe).filter((r): r is number => r != null);
  const avgRpe = rpes.length ? rpes.reduce((a, r) => a + r, 0) / rpes.length : null;
  const hardSets = working.filter((s) => s.rpe != null && s.rpe > 9).length;

  // ── deload week (§2.2) — cap intensity regardless of last performance ─────
  if (opts.deload) {
    return {
      targetWeightKg: roundToPlate(lastWeight * 0.9, opts.unit),
      targetReps: repMin,
      targetRpe: 7,
      note: `Deload week — ${fmtWeight(roundToPlate(lastWeight * 0.9, opts.unit), opts.unit)} for easy sets, stop at RPE 7.`,
      rule: "deload_week → -10%_load_rpe<=7",
    };
  }

  // ── back-off (§2.1) — missed the bottom of the range, or grinding ────────
  if (minReps < repMin || hardSets >= 2) {
    const w = roundToPlate(lastWeight * 0.9, opts.unit);
    return {
      targetWeightKg: w,
      targetReps: repMax,
      targetRpe: 8,
      note: `Last time was a grind — back off to ${fmtWeight(w, opts.unit)} and rebuild the range.`,
      rule: minReps < repMin ? "missed_bottom_of_range → -10%" : "rpe>9_on_2+_sets → -10%",
    };
  }

  // ── progression — hit the top of the range at a manageable RPE ───────────
  const allAtTop = repsAtTop.length > 0 && repsAtTop.every((r) => r >= repMax);
  if (allAtTop && avgRpe != null && avgRpe <= 8) {
    const factor = avgRpe <= 7 ? 1.05 : 1.025;
    const w = roundToPlate(lastWeight * factor, opts.unit);
    return {
      targetWeightKg: w,
      targetReps: repMax,
      targetRpe: 8.5,
      note: `You owned ${repMax} reps last time — up to ${fmtWeight(w, opts.unit)} today.`,
      rule: `top_of_range_rpe<=${avgRpe <= 7 ? 7 : 8} → +${factor === 1.05 ? "5" : "2.5"}%`,
    };
  }

  // ── mid-range at RPE 8–9 → hold load, chase one more rep ─────────────────
  if (avgRpe == null || (avgRpe >= 8 && avgRpe <= 9)) {
    const target = Math.min(repMax, Math.max(...repsAtTop) + 1);
    return {
      targetWeightKg: roundToPlate(lastWeight, opts.unit),
      targetReps: target,
      targetRpe: 9,
      note: `Same ${fmtWeight(lastWeight, opts.unit)} — aim for ${target} reps before we add load.`,
      rule: "mid_range_rpe_8-9 → hold_load_+1_rep",
    };
  }

  // ── default — repeat and consolidate ────────────────────────────────────
  return {
    targetWeightKg: roundToPlate(lastWeight, opts.unit),
    targetReps: repMax,
    targetRpe: 8,
    note: `Repeat ${fmtWeight(lastWeight, opts.unit)} and tighten up every rep.`,
    rule: "default → repeat",
  };
}

export interface PrescribeResult {
  prescription: Prescription;
  /** The exact history/counters the rule saw — persisted on the audit row. */
  inputs: Record<string, unknown>;
}

/**
 * DB-backed wrapper: pull the most recent completed working sets for an exercise
 * and run the pure core. Returns the prescription plus the audit inputs.
 */
export async function prescribeExercise(
  userId: string,
  exerciseId: string,
  template: PrescriptionTemplate,
  opts: PrescriptionOptions,
): Promise<PrescribeResult> {
  const rows = await prisma.exerciseSet.findMany({
    where: {
      isWarmup: false,
      weightKg: { not: null },
      reps: { not: null },
      performance: { exerciseId, session: { userId, status: "completed" } },
    },
    select: {
      weightKg: true,
      reps: true,
      rpe: true,
      performance: { select: { sessionId: true, session: { select: { startedAt: true } } } },
    },
    orderBy: { performance: { session: { startedAt: "desc" } } },
    take: 40,
  });

  // most recent session only
  const latestSessionId = rows[0]?.performance.sessionId ?? null;
  const lastSets: WorkingSet[] = rows
    .filter((r) => r.performance.sessionId === latestSessionId)
    .map((r) => ({ weightKg: r.weightKg!, reps: r.reps!, rpe: r.rpe }));

  const prescription = computePrescription(template, { lastSets }, opts);

  return {
    prescription,
    inputs: {
      exerciseId,
      unit: opts.unit,
      deload: !!opts.deload,
      repRange: [template.targetRepsMin, template.targetRepsMax],
      templateWeightKg: template.targetWeightKg,
      lastSessionId: latestSessionId,
      lastSets,
    },
  };
}
