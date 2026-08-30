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
}

/**
 * Readiness 0–100 (§8.1). On mobile the client blends HealthKit / Health Connect
 * sleep + HRV + resting HR + prior-day strain on-device. Server-side we
 * approximate from the latest synced metrics + recent training load, falling
 * back to a load-only estimate when no health data is present.
 */
export async function computeReadiness(userId: string): Promise<number> {
  return (await readinessBreakdown(userId)).score;
}

export async function readinessFactors(userId: string): Promise<ReadinessBreakdown> {
  return readinessBreakdown(userId);
}

async function readinessBreakdown(userId: string): Promise<ReadinessBreakdown> {
  const since = new Date(Date.now() - 3 * 86_400_000);
  const [sleep, hrv, rhr, recentSessions] = await Promise.all([
    latest(userId, "sleep"),
    latest(userId, "hrv"),
    latest(userId, "resting_hr"),
    prisma.workoutSession.findMany({ where: { userId, status: "completed", startedAt: { gte: since } } }),
  ]);

  let score = 70;
  const factors: ReadinessFactor[] = [];

  if (sleep != null) {
    const d = clamp((sleep - 7) * 8, -20, 15);
    score += d;
    factors.push({ label: "sleep", value: `${sleep.toFixed(1)}h`, fraction: clamp(sleep / 9, 0, 1) });
  }
  if (hrv != null) {
    score += clamp((hrv - 60) * 0.4, -12, 12);
    factors.push({ label: "hrv", value: `${Math.round(hrv)} ms`, fraction: clamp(hrv / 100, 0, 1) });
  }
  if (rhr != null) {
    score += clamp((55 - rhr) * 0.8, -12, 10);
    factors.push({ label: "resting hr", value: `${Math.round(rhr)} bpm`, fraction: clamp((80 - rhr) / 40, 0, 1) });
  }

  const strain = recentSessions.reduce((a, s) => a + s.totalVolumeKg, 0);
  score -= clamp(strain / 4000, 0, 18);
  factors.push({
    label: "prior-day strain",
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

  return { score: final, factors, recommendation };
}
