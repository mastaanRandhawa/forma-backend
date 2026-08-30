import { prisma } from "../prisma.js";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

async function latest(userId: string, metricType: string) {
  const row = await prisma.progressMetric.findFirst({
    where: { userId, metricType: metricType as never },
    orderBy: { recordedAt: "desc" },
  });
  return row?.value ?? null;
}

export interface ReadinessFactor {
  label: string;
  value: string;
  fraction: number; // 0..1 contribution health
}

export interface ReadinessBreakdown {
  score: number;
  factors: ReadinessFactor[];
  recommendation: string;
  /** true when at least one real recovery input (wearable or check-in) was present. */
  hasRecoveryInput: boolean;
}

/**
 * Readiness 0–100 (§8.1). On mobile the client blends HealthKit / Health Connect
 * sleep + HRV + resting HR + recent training load on-device. Server-side we
 * approximate from the latest synced metrics and, failing those, the manual
 * recovery check-in (§3.1) — never synthesising an HRV / resting-HR number.
 */
export async function computeReadiness(userId: string): Promise<number> {
  return (await readinessBreakdown(userId)).score;
}

export async function readinessFactors(userId: string): Promise<ReadinessBreakdown> {
  return readinessBreakdown(userId);
}

async function readinessBreakdown(userId: string): Promise<ReadinessBreakdown> {
  const since = new Date(Date.now() - 3 * 86_400_000);
  const [sleep, hrv, rhr, recentSessions, checkin] = await Promise.all([
    latest(userId, "sleep"),
    latest(userId, "hrv"),
    latest(userId, "resting_hr"),
    prisma.workoutSession.findMany({ where: { userId, status: "completed", startedAt: { gte: since } } }),
    prisma.recoveryCheckin.findFirst({
      where: { userId, recordedAt: { gte: since } },
      orderBy: { recordedAt: "desc" },
    }),
  ]);

  let score = 70;
  const factors: ReadinessFactor[] = [];
  let hasRecoveryInput = false;

  if (sleep != null) {
    hasRecoveryInput = true;
    const d = clamp((sleep - 7) * 8, -20, 15);
    score += d;
    factors.push({ label: "sleep", value: `${sleep.toFixed(1)}h`, fraction: clamp(sleep / 9, 0, 1) });
  }
  if (hrv != null) {
    hasRecoveryInput = true;
    score += clamp((hrv - 60) * 0.4, -12, 12);
    factors.push({ label: "hrv", value: `${Math.round(hrv)} ms`, fraction: clamp(hrv / 100, 0, 1) });
  }
  if (rhr != null) {
    hasRecoveryInput = true;
    score += clamp((55 - rhr) * 0.8, -12, 10);
    factors.push({ label: "resting hr", value: `${Math.round(rhr)} bpm`, fraction: clamp((80 - rhr) / 40, 0, 1) });
  }

  // Manual check-in — a first-class factor only when no wearable data is present.
  if (checkin && sleep == null && hrv == null && rhr == null) {
    hasRecoveryInput = true;
    if (checkin.sleepH != null) {
      score += clamp((checkin.sleepH - 7) * 7, -18, 12);
      factors.push({ label: "sleep (self-reported)", value: `${checkin.sleepH.toFixed(1)}h`, fraction: clamp(checkin.sleepH / 9, 0, 1) });
    }
    if (checkin.sleepQuality != null) {
      score += clamp((checkin.sleepQuality - 3) * 4, -8, 8);
      factors.push({ label: "sleep quality", value: `${checkin.sleepQuality}/5`, fraction: clamp(checkin.sleepQuality / 5, 0, 1) });
    }
    if (checkin.fatigue != null) {
      score += clamp((3 - checkin.fatigue) * 5, -10, 10);
      factors.push({ label: "fatigue", value: `${checkin.fatigue}/5`, fraction: clamp((5 - checkin.fatigue) / 5, 0, 1) });
    }
    if (checkin.soreness != null) {
      score += clamp((3 - checkin.soreness) * 4, -8, 8);
      factors.push({ label: "soreness", value: `${checkin.soreness}/5`, fraction: clamp((5 - checkin.soreness) / 5, 0, 1) });
    }
  }

  const strain = recentSessions.reduce((a, s) => a + s.totalVolumeKg, 0);
  score -= clamp(strain / 4000, 0, 18);
  factors.push({
    label: "recent training load (3d)",
    value: strain > 12000 ? "high" : strain > 5000 ? "moderate" : "low",
    fraction: clamp(1 - strain / 20000, 0, 1),
  });

  const final = Math.round(clamp(score, 5, 99));
  const recommendation =
    final >= 75
      ? "Full-intensity training is cleared. Push your top sets."
      : final >= 55
        ? "Train as planned but keep top-set RPE at or below 8."
        : "Recovery is low — reduce volume, cap intensity, and prioritise sleep tonight.";

  return { score: final, factors, recommendation, hasRecoveryInput };
}

export interface ReadinessAdjustment {
  applied: boolean;
  score: number;
  hasRecoveryInput: boolean;
  accessorySetDelta: number; // e.g. -1
  rpeCap: number | null;
  swapHeaviestCompound: boolean;
  reason: string;
  rule: string;
}

/**
 * Session-scoped low-readiness modifier (§2.3). A no-op — and honest about it —
 * until a real recovery input exists.
 */
export async function readinessAdjustment(userId: string): Promise<ReadinessAdjustment> {
  const b = await readinessBreakdown(userId);
  if (!b.hasRecoveryInput) {
    return {
      applied: false,
      score: b.score,
      hasRecoveryInput: false,
      accessorySetDelta: 0,
      rpeCap: null,
      swapHeaviestCompound: false,
      reason: "No recovery data yet — training as planned. Add a check-in for readiness-aware sessions.",
      rule: "no_recovery_input → no_op",
    };
  }
  if (b.score >= 55) {
    return {
      applied: false,
      score: b.score,
      hasRecoveryInput: true,
      accessorySetDelta: 0,
      rpeCap: b.score >= 75 ? null : 8,
      swapHeaviestCompound: false,
      reason: b.recommendation,
      rule: "readiness>=55 → as_planned",
    };
  }
  return {
    applied: true,
    score: b.score,
    hasRecoveryInput: true,
    accessorySetDelta: -1,
    rpeCap: 8,
    swapHeaviestCompound: true,
    reason: `Readiness is ${b.score}. Trimming a set from accessories, capping RPE at 8, and suggesting a machine variant for your heaviest compound.`,
    rule: "readiness<55 → -1_accessory_set_rpe<=8_swap_compound",
  };
}
