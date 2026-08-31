import { prisma } from "../prisma.js";

/**
 * Deload detection (§2.2). Deterministic and week-scoped: once a deload has been
 * prescribed, the audit row keeps it "on" for ~7 days and suppresses re-trigger
 * for 4 weeks.
 */

export interface DeloadSignal {
  deload: boolean;
  reason: string;
  rule: string;
  inputs: Record<string, unknown>;
}

interface SessionPoint {
  startedAt: Date;
  totalVolumeKg: number;
}

interface CheckinPoint {
  recordedAt: Date;
  fatigue: number | null;
  soreness: number | null;
}

const DAY = 86_400_000;
const DELOAD_WEEK_MS = 7 * DAY;
const DELOAD_COOLDOWN_MS = 28 * DAY;
const MIN_HISTORY_FOR_TIME_TRIGGER = 8;

/** Pure core — every branch covered by deload.test.ts. */
export function evaluateDeloadSignals(args: {
  now: number;
  sessions: SessionPoint[]; // completed, ascending by startedAt, last ~6 weeks
  lastDeloadAt: Date | null;
  checkins: CheckinPoint[]; // last 7 days
  totalCompletedSessions: number;
}): DeloadSignal {
  const { now, sessions, lastDeloadAt, checkins, totalCompletedSessions } = args;
  const base = { sessionsSeen: sessions.length, lastDeloadAt, checkinsSeen: checkins.length };

  // Mid-deload-week: a deload was prescribed within the last 7 days.
  if (lastDeloadAt && now - lastDeloadAt.getTime() < DELOAD_WEEK_MS) {
    return { deload: true, reason: "Deload week in progress.", rule: "deload_audit<7d → hold", inputs: base };
  }

  // Cooldown: don't re-trigger within 4 weeks of the last deload.
  const inCooldown = !!lastDeloadAt && now - lastDeloadAt.getTime() < DELOAD_COOLDOWN_MS;

  // Signal 1 — 3+ consecutive completed sessions with strictly declining volume.
  const tail = sessions.slice(-4).filter((s) => s.totalVolumeKg > 0);
  if (!inCooldown && tail.length >= 3) {
    let declining = true;
    for (let i = 1; i < tail.length; i++) if (tail[i]!.totalVolumeKg >= tail[i - 1]!.totalVolumeKg) declining = false;
    if (declining) {
      return {
        deload: true,
        reason: "Working-set volume has dropped for 3+ sessions straight.",
        rule: "declining_volume_3+_sessions → deload",
        inputs: { ...base, tailVolumes: tail.map((s) => Math.round(s.totalVolumeKg)) },
      };
    }
  }

  // Signal 2 — 4 weeks since the last deload (with enough training history).
  if (!inCooldown && totalCompletedSessions >= MIN_HISTORY_FOR_TIME_TRIGGER) {
    const sinceMs = lastDeloadAt ? now - lastDeloadAt.getTime() : Infinity;
    const firstSession = sessions[0];
    const trainingSpanMs = firstSession ? now - firstSession.startedAt.getTime() : 0;
    if (sinceMs >= DELOAD_COOLDOWN_MS && trainingSpanMs >= DELOAD_COOLDOWN_MS) {
      return {
        deload: true,
        reason: "It's been about four weeks of hard training — time to back off a week.",
        rule: "4_weeks_since_deload → deload",
        inputs: { ...base, daysSinceDeload: lastDeloadAt ? Math.round(sinceMs / DAY) : null },
      };
    }
  }

  // Signal 3 — a run of low-recovery check-ins.
  const rough = checkins.filter((c) => (c.fatigue ?? 0) >= 4 || (c.soreness ?? 0) >= 4).length;
  if (!inCooldown && rough >= 3) {
    return {
      deload: true,
      reason: "Several rough recovery check-ins this week.",
      rule: "low_recovery_checkins_3+ → deload",
      inputs: { ...base, roughCheckins: rough },
    };
  }

  return { deload: false, reason: "Training load and recovery are in range.", rule: "none", inputs: base };
}

/** DB-backed wrapper. */
export async function shouldDeload(userId: string): Promise<DeloadSignal> {
  const now = Date.now();
  const since = new Date(now - 45 * DAY);
  const [sessions, lastDeload, checkins, totalCompletedSessions] = await Promise.all([
    prisma.workoutSession.findMany({
      where: { userId, status: "completed", startedAt: { gte: since } },
      orderBy: { startedAt: "asc" },
      select: { startedAt: true, totalVolumeKg: true },
    }),
    prisma.recommendationAudit.findFirst({
      where: { userId, kind: "deload" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.recoveryCheckin.findMany({
      where: { userId, recordedAt: { gte: new Date(now - 7 * DAY) } },
      select: { recordedAt: true, fatigue: true, soreness: true },
    }),
    prisma.workoutSession.count({ where: { userId, status: "completed" } }),
  ]);

  return evaluateDeloadSignals({
    now,
    sessions,
    lastDeloadAt: lastDeload?.createdAt ?? null,
    checkins,
    totalCompletedSessions,
  });
}
