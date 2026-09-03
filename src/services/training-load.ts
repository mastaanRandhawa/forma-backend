/**
 * Training Load — CTL/ATL analogue (§3.1)
 *
 * Chronic Training Load (CTL) = exponential moving average of daily TRIMP over 42 days.
 * Acute Training Load (ATL)  = exponential moving average of daily TRIMP over 7 days.
 * Training Stress Balance (TSB) = CTL − ATL  (positive = fresh, negative = fatigued)
 *
 * TRIMP proxy: session totalVolumeKg / 1000 + (avgRpe − 5) * 0.2, floored at 0.
 * This keeps the scale comparable to the Banister model without requiring HR data.
 */

import { prisma } from "../prisma.js";

export interface TrainingLoadResult {
  ctl: number;    // chronic (42-day), 0–100 scale
  atl: number;    // acute (7-day),   0–100 scale
  tsb: number;    // CTL − ATL, positive = fresh
  status: "fresh" | "optimal" | "fatigued" | "overreaching";
  weeklyTrimp: number[];  // last 8 weeks TRIMP, oldest first
}

const CTL_DAYS = 42;
const ATL_DAYS = 7;
const k_ctl = 2 / (CTL_DAYS + 1);
const k_atl = 2 / (ATL_DAYS + 1);

/** Session TRIMP proxy: blends volume and RPE into a single effort unit. */
function sessionTrimp(volumeKg: number, avgRpe: number | null): number {
  const vol = volumeKg / 1000;
  const rpeBonus = avgRpe != null ? Math.max(0, (avgRpe - 5) * 0.25) : 0;
  return Math.max(0, vol + rpeBonus);
}

export async function computeTrainingLoad(userId: string): Promise<TrainingLoadResult> {
  const since = new Date(Date.now() - 84 * 86400_000); // 12 weeks of data

  const sessions = await prisma.workoutSession.findMany({
    where: { userId, status: "completed", startedAt: { gte: since } },
    include: {
      performances: {
        include: { sets: { where: { isWarmup: false, completedAt: { not: null } } } },
      },
    },
    orderBy: { startedAt: "asc" },
  });

  // build a day-keyed TRIMP map
  const trimpByDay: Record<string, number> = {};
  for (const s of sessions) {
    const day = s.startedAt.toISOString().slice(0, 10);
    const allSets = s.performances.flatMap((p) => p.sets);
    const rpeVals = allSets.map((st) => st.rpe).filter((r): r is number => r != null);
    const avgRpe = rpeVals.length ? rpeVals.reduce((a, b) => a + b, 0) / rpeVals.length : null;
    trimpByDay[day] = (trimpByDay[day] ?? 0) + sessionTrimp(s.totalVolumeKg, avgRpe);
  }

  // fill a 84-day array
  const today = new Date();
  const days: number[] = [];
  for (let i = 83; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(trimpByDay[key] ?? 0);
  }

  // EMA for CTL and ATL
  let ctl = 0;
  let atl = 0;
  for (const t of days) {
    ctl = t * k_ctl + ctl * (1 - k_ctl);
    atl = t * k_atl + atl * (1 - k_atl);
  }

  // weekly TRIMP for the sparkline (last 8 weeks)
  const weeklyTrimp: number[] = [];
  for (let w = 7; w >= 0; w--) {
    const weekDays = days.slice(days.length - 7 * (w + 1), days.length - 7 * w);
    weeklyTrimp.push(weekDays.reduce((a, b) => a + b, 0));
  }

  const tsb = ctl - atl;

  let status: TrainingLoadResult["status"];
  if (tsb > 5) status = "fresh";
  else if (tsb >= -10) status = "optimal";
  else if (tsb >= -20) status = "fatigued";
  else status = "overreaching";

  return {
    ctl: Math.round(ctl * 10) / 10,
    atl: Math.round(atl * 10) / 10,
    tsb: Math.round(tsb * 10) / 10,
    status,
    weeklyTrimp: weeklyTrimp.map((v) => Math.round(v * 10) / 10),
  };
}
