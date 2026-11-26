/**
 * Named progression rules. Deterministic, no I/O, no LLM: given what you did
 * recently and the routine's targets, decide the next target and say why.
 *
 *   linear              add weight every session you hit all your reps; repeat when
 *                       you miss; take 10% off after three misses in a row.
 *   greyskull           the last set of each exercise is "as many reps as you can";
 *                       5+ adds weight, 10+ adds double, under 5 drops 10%.
 *   double_progression  add reps inside the range first; add weight once every set
 *                       reaches the top of the range, and start the range again.
 *   added_time          for holds: add seconds when every set reached the target.
 *
 * `auto` (the RPE-based engine in prescription.ts) is not handled here.
 * The note on each result is the provenance shown to the user: where the number
 * came from. The rule string is machine-readable and stored on the audit row.
 */
import { roundToPlate, type Prescription, type Unit } from "./prescription.js";

export type NamedRule = "linear" | "greyskull" | "double_progression" | "added_time";

export interface SessionSets {
  /** working sets of one finished session, in set order */
  sets: { weightKg: number; reps: number; rpe: number | null; durationSeconds?: number | null }[];
}

export interface RuleTemplate {
  targetSets: number;
  targetRepsMin: number | null;
  targetRepsMax: number | null;
  targetWeightKg: number | null;
  targetDurationSec?: number | null;
}

export interface RuleOptions {
  unit: Unit;
  deload?: boolean;
  /** what the rule adds on success; defaults to 2.5 kg (5 lb) */
  incrementKg?: number | null;
  /** seconds added by added_time; defaults to 5 */
  incrementSec?: number;
}

export interface NamedPrescription extends Prescription {
  targetDurationSec: number | null;
}

const LB_PER_KG = 2.2046226218;
const round1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (kg: number, unit: Unit) => (unit === "imperial" ? `${Math.round(kg * LB_PER_KG)} lb` : `${round1(kg)} kg`);
const defaultStep = (unit: Unit) => (unit === "imperial" ? 5 / LB_PER_KG : 2.5);

const topWeight = (s: SessionSets) => Math.max(...s.sets.map((x) => x.weightKg));
const atTop = (s: SessionSets) => s.sets.filter((x) => x.weightKg >= topWeight(s) - 1e-6);

export const RULE_LABEL: Record<NamedRule, string> = {
  linear: "Linear progression",
  greyskull: "Greyskull LP",
  double_progression: "Double progression",
  added_time: "Added time",
};

/** Next target under a named rule. `history` is finished sessions, newest first. */
export function computeNamedPrescription(
  rule: NamedRule,
  template: RuleTemplate,
  history: SessionSets[],
  opts: RuleOptions,
): NamedPrescription {
  const label = RULE_LABEL[rule];
  const step = opts.incrementKg && opts.incrementKg > 0 ? opts.incrementKg : defaultStep(opts.unit);
  const repMin = template.targetRepsMin ?? 5;
  const repMax = template.targetRepsMax ?? template.targetRepsMin ?? repMin;
  const base = (weightKg: number | null, reps: number | null, note: string, why: string): NamedPrescription => ({
    targetWeightKg: weightKg != null ? roundToPlate(weightKg, opts.unit) : null,
    targetReps: reps,
    targetRpe: null,
    targetDurationSec: null,
    note: `${label}: ${note}`,
    rule: `${rule}: ${why}`,
  });

  // ── holds ─────────────────────────────────────────────────────────────────
  if (rule === "added_time") {
    const stepSec = opts.incrementSec ?? 5;
    const last = history[0]?.sets.filter((s) => (s.durationSeconds ?? 0) > 0) ?? [];
    const goal = template.targetDurationSec ?? null;
    if (!last.length) {
      const start = goal ?? 30;
      return { ...base(null, null, `no holds logged yet, so start with ${start} s per set.`, "no_history → start"), targetDurationSec: start };
    }
    const shortest = Math.min(...last.map((s) => s.durationSeconds!));
    const target = goal ?? shortest;
    if (shortest >= target) {
      const next = Math.max(target, shortest) + stepSec;
      return { ...base(null, null, `every set reached ${target} s last time, so ${next} s today.`, `all_sets_hit_${target}s → +${stepSec}s`), targetDurationSec: next };
    }
    return { ...base(null, null, `your shortest set was ${shortest} s against ${target} s, so repeat ${target} s.`, `missed_${target}s → repeat`), targetDurationSec: target };
  }

  // ── weighted rules need a weight to work from ────────────────────────────
  const last = history[0];
  if (!last || !last.sets.length) {
    const w = template.targetWeightKg ?? null;
    return base(
      w,
      rule === "double_progression" ? repMin : repMax,
      w != null ? `no history yet, so start at ${fmt(roundToPlate(w, opts.unit), opts.unit)}.` : "no history yet. Log honest weights today and the rule takes over next session.",
      w != null ? "no_history → template_target" : "no_history → no_target",
    );
  }
  const w = topWeight(last);

  if (opts.deload) {
    const d = roundToPlate(w * 0.9, opts.unit);
    return base(d, repMin, `deload week, ${fmt(d, opts.unit)} (10% lighter).`, "deload_week → -10%");
  }

  if (rule === "linear") {
    const goalReps = repMax;
    const hit = atTop(last);
    const success = hit.length >= template.targetSets && hit.every((s) => s.reps >= goalReps);
    if (success) {
      const next = w + step;
      return base(next, goalReps, `you hit ${template.targetSets} × ${goalReps} at ${fmt(w, opts.unit)}, so add ${fmt(roundToPlate(step, opts.unit), opts.unit)}.`, `all_sets_hit_${goalReps}_reps → +increment`);
    }
    // three sessions in a row at this weight without hitting it: take 10% off
    const stalls = history.slice(0, 3).filter((s) => {
      const t = atTop(s);
      return Math.abs(topWeight(s) - w) < 1e-6 && !(t.length >= template.targetSets && t.every((x) => x.reps >= goalReps));
    }).length;
    if (history.length >= 3 && stalls === 3) {
      const d = roundToPlate(w * 0.9, opts.unit);
      return base(d, goalReps, `three sessions at ${fmt(w, opts.unit)} without all ${template.targetSets} × ${goalReps}, so drop to ${fmt(d, opts.unit)} and build back.`, "three_stalls → -10%");
    }
    return base(w, goalReps, `you didn't get all ${template.targetSets} × ${goalReps} at ${fmt(w, opts.unit)}, so repeat it.`, "missed_reps → repeat");
  }

  if (rule === "greyskull") {
    const standard = repMin;
    const amrapReps = last.sets[last.sets.length - 1].reps;
    const hitStandard = last.sets.slice(0, -1).every((s) => s.reps >= standard);
    if (amrapReps >= standard * 2 && hitStandard) {
      const next = w + 2 * step;
      return base(next, standard, `your last set was ${amrapReps} reps (${standard * 2}+), so add double: ${fmt(roundToPlate(2 * step, opts.unit), opts.unit)}.`, `amrap_${standard * 2}+ → +2×increment`);
    }
    if (amrapReps >= standard && hitStandard) {
      return base(w + step, standard, `your last set was ${amrapReps} reps (${standard}+), so add ${fmt(roundToPlate(step, opts.unit), opts.unit)}.`, `amrap_${standard}+ → +increment`);
    }
    const d = roundToPlate(w * 0.9, opts.unit);
    return base(d, standard, `you stalled at ${fmt(w, opts.unit)} (last set ${amrapReps} reps), so drop 10% to ${fmt(d, opts.unit)} and work back up.`, `amrap_<${standard} → -10%`);
  }

  // double_progression
  const sets = atTop(last);
  const allTop = sets.length >= template.targetSets && sets.every((s) => s.reps >= repMax);
  if (allTop) {
    return base(w + step, repMin, `every set reached ${repMax} reps at ${fmt(w, opts.unit)}, so add ${fmt(roundToPlate(step, opts.unit), opts.unit)} and start the range again at ${repMin}.`, `all_sets_top_of_${repMin}-${repMax} → +increment, reset_reps`);
  }
  const lowest = Math.min(...sets.map((s) => s.reps));
  const target = Math.min(repMax, Math.max(repMin, lowest + 1));
  return base(w, target, `hold ${fmt(w, opts.unit)} and aim for ${target} reps on every set (your lowest was ${lowest}). Weight goes up once all sets reach ${repMax}.`, `below_top_of_range → hold_load_+1_rep`);
}

/** What each rule does, in plain words, for pickers in the apps. */
export const RULE_INFO: { id: "auto" | NamedRule; label: string; summary: string; best: string }[] = [
  { id: "auto", label: "Automatic", summary: "Reads your reps and effort (RPE) and decides whether to add weight, hold or back off.", best: "Most people" },
  { id: "linear", label: RULE_LABEL.linear, summary: "Add weight every session you hit all your sets and reps. Repeat when you miss; take 10% off after three misses in a row.", best: "Beginners on 5 × 5 style routines" },
  { id: "greyskull", label: RULE_LABEL.greyskull, summary: "The last set of each exercise is as many reps as you can. 5+ adds weight, 10+ adds double, under 5 drops 10%.", best: "Simple 3-set routines" },
  { id: "double_progression", label: RULE_LABEL.double_progression, summary: "Add reps inside your range first. Once every set reaches the top, add weight and start the range again.", best: "Accessories and machines" },
  { id: "added_time", label: RULE_LABEL.added_time, summary: "For holds like planks: add a few seconds each time every set reaches the target.", best: "Timed exercises" },
];
