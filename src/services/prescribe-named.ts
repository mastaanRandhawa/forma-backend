import { prisma } from "../prisma.js";
import { computeNamedPrescription, type NamedPrescription, type NamedRule, type RuleOptions, type RuleTemplate, type SessionSets } from "./progression-rules.js";

/** How many finished sessions a rule looks back over (linear needs three to spot a stall). */
const LOOKBACK = 3;

/**
 * DB-backed wrapper: read the last few finished sessions for an exercise and run a
 * named rule. Returns the prescription and the exact inputs it saw, for the audit row.
 */
export async function prescribeNamedExercise(
  userId: string,
  exerciseId: string,
  rule: NamedRule,
  template: RuleTemplate,
  opts: RuleOptions,
): Promise<{ prescription: NamedPrescription; inputs: Record<string, unknown> }> {
  const timed = rule === "added_time";
  const perfs = await prisma.exercisePerformance.findMany({
    where: { exerciseId, session: { userId, status: "completed" } },
    orderBy: { session: { startedAt: "desc" } },
    take: LOOKBACK,
    include: { sets: { where: { isWarmup: false }, orderBy: { setNumber: "asc" } } },
  });
  const history: SessionSets[] = perfs
    .map((p) => ({
      sets: p.sets
        .filter((s) => (timed ? (s.durationSeconds ?? 0) > 0 : s.weightKg != null && (s.reps ?? 0) > 0))
        .map((s) => ({ weightKg: s.weightKg ?? 0, reps: s.reps ?? 0, rpe: s.rpe, durationSeconds: s.durationSeconds })),
    }))
    .filter((h) => h.sets.length);

  const prescription = computeNamedPrescription(rule, template, history, opts);
  return {
    prescription,
    inputs: {
      exerciseId,
      rule,
      unit: opts.unit,
      deload: !!opts.deload,
      incrementKg: opts.incrementKg ?? null,
      template,
      sessions: history,
    },
  };
}
