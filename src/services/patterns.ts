/**
 * Behavioral pattern analysis (§4.2 / §4.3)
 *
 * - adherenceByDayOfWeek: completion rate by DOW (0=Sun…6=Sat)
 * - circadianPerformance: avg volume per time-of-day bucket
 *
 * Requires ≥30 completed sessions for reliable signal; returns null below that.
 */

import { prisma } from "../prisma.js";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const HOUR_BUCKETS = [
  { label: "Early morning", from: 5,  to: 9  },
  { label: "Morning",       from: 9,  to: 12 },
  { label: "Afternoon",     from: 12, to: 17 },
  { label: "Evening",       from: 17, to: 21 },
  { label: "Night",         from: 21, to: 24 },
] as const;

export interface DayAdherence {
  day: string;
  sessions: number;
  completionRate: number; // 0-1, vs. user's average session rate
}

export interface CircadianBucket {
  label: string;
  sessions: number;
  avgVolumeKg: number;
  relativePerformance: number; // % above/below personal average (0 = avg)
}

export interface PatternInsights {
  bestDay: string | null;
  worstDay: string | null;
  bestTimeWindow: string | null;
  adherenceByDay: DayAdherence[];
  circadian: CircadianBucket[];
  insight: string | null;
}

export async function analyzePatterns(userId: string): Promise<PatternInsights | null> {
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, status: "completed" },
    select: { startedAt: true, totalVolumeKg: true },
    orderBy: { startedAt: "asc" },
  });

  if (sessions.length < 30) return null;

  // Day-of-week adherence
  const dowCounts = new Array(7).fill(0) as number[];
  for (const s of sessions) dowCounts[s.startedAt.getDay()]++;
  const total = sessions.length;
  const avgPerDay = total / 7;
  const adherenceByDay: DayAdherence[] = DOW.map((day, i) => ({
    day,
    sessions: dowCounts[i],
    completionRate: avgPerDay > 0 ? dowCounts[i] / avgPerDay : 0,
  }));

  const sorted = [...adherenceByDay].sort((a, b) => b.completionRate - a.completionRate);
  const bestDay = sorted[0].sessions >= 3 ? sorted[0].day : null;
  const worstDay = sorted[sorted.length - 1].sessions >= 1 ? sorted[sorted.length - 1].day : null;

  // Circadian buckets
  const avgVol = sessions.reduce((s, r) => s + r.totalVolumeKg, 0) / sessions.length;
  const circadian: CircadianBucket[] = HOUR_BUCKETS.map((b) => {
    const inBucket = sessions.filter((s) => {
      const h = s.startedAt.getHours();
      return h >= b.from && h < b.to;
    });
    const bucketAvg = inBucket.length
      ? inBucket.reduce((s, r) => s + r.totalVolumeKg, 0) / inBucket.length
      : 0;
    return {
      label: b.label,
      sessions: inBucket.length,
      avgVolumeKg: Math.round(bucketAvg),
      relativePerformance: avgVol > 0 ? Math.round(((bucketAvg - avgVol) / avgVol) * 100) : 0,
    };
  });

  const bestBucket = [...circadian]
    .filter((c) => c.sessions >= 5)
    .sort((a, b) => b.relativePerformance - a.relativePerformance)[0];
  const bestTimeWindow = bestBucket?.relativePerformance > 5 ? bestBucket.label : null;

  // Build the human-readable insight
  let insight: string | null = null;
  if (bestDay && worstDay && bestDay !== worstDay) {
    const bestRate = Math.round(
      (adherenceByDay.find((d) => d.day === bestDay)?.completionRate ?? 1) * 100,
    );
    const worstRate = Math.round(
      (adherenceByDay.find((d) => d.day === worstDay)?.completionRate ?? 0) * 100,
    );
    insight = `You train most on ${bestDay}s (${bestRate}% of your average) and least on ${worstDay}s (${worstRate}%).`;
  }
  if (bestTimeWindow && bestBucket) {
    const addendum = `${bestTimeWindow} sessions average ${bestBucket.relativePerformance}% more volume than your overall average.`;
    insight = insight ? `${insight} ${addendum}` : addendum;
  }

  return { bestDay, worstDay, bestTimeWindow, adherenceByDay, circadian, insight };
}
