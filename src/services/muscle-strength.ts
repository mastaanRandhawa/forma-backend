/**
 * Strength by muscle: how long since each muscle was trained, and the lifts behind
 * it with their best estimated 1RM. Pure; the route reads the rows and calls this.
 */

export type MuscleStatus = "never" | "recovering" | "ready" | "due" | "overdue";

export interface GroupRow {
  id: string;
  key: string;
  name: string;
  region: string;
}
/** One primary-muscle workout: which muscle, and when the session started. */
export interface ActivationRow {
  muscleGroupId: string;
  at: Date;
}
/** A best estimated 1RM record, with the muscles the exercise works as its primary movers. */
export interface LiftRow {
  exercise: { slug: string; name: string; primaryMuscleGroupIds: string[] };
  e1rmKg: number;
  achievedAt: Date;
}

export interface MuscleStrength {
  key: string;
  name: string;
  region: string;
  lastTrainedAt: Date | null;
  daysSince: number | null;
  status: MuscleStatus;
  lifts: { slug: string; name: string; e1rmKg: number; achievedAt: Date }[];
}

const DAY = 86_400_000;

/** 0–2 days: still recovering · 3–7: ready · 8–14: due · over 14: overdue. */
export function statusFor(daysSince: number | null): MuscleStatus {
  if (daysSince == null) return "never";
  if (daysSince <= 2) return "recovering";
  if (daysSince <= 7) return "ready";
  if (daysSince <= 14) return "due";
  return "overdue";
}

export function buildMuscleStrength(groups: GroupRow[], activations: ActivationRow[], lifts: LiftRow[], now: Date, topLifts = 3): MuscleStrength[] {
  const last = new Map<string, Date>();
  for (const a of activations) {
    const cur = last.get(a.muscleGroupId);
    if (!cur || a.at > cur) last.set(a.muscleGroupId, a.at);
  }
  // best record per exercise, then the top few per muscle
  const bestByExercise = new Map<string, LiftRow>();
  for (const l of lifts) {
    const cur = bestByExercise.get(l.exercise.slug);
    if (!cur || l.e1rmKg > cur.e1rmKg) bestByExercise.set(l.exercise.slug, l);
  }
  return groups.map((g) => {
    const at = last.get(g.id) ?? null;
    const daysSince = at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY)) : null;
    const behind = [...bestByExercise.values()]
      .filter((l) => l.exercise.primaryMuscleGroupIds.includes(g.id))
      .sort((a, b) => b.e1rmKg - a.e1rmKg)
      .slice(0, topLifts)
      .map((l) => ({ slug: l.exercise.slug, name: l.exercise.name, e1rmKg: l.e1rmKg, achievedAt: l.achievedAt }));
    return { key: g.key, name: g.name, region: g.region, lastTrainedAt: at, daysSince, status: statusFor(daysSince), lifts: behind };
  });
}
