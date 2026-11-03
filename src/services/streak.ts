import { prisma } from "../prisma.js";
import { FREEZE_MIN_STREAK, STREAK_REPAIR } from "../data/economy.js";

// ── the user's calendar ────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" for `d` in a zone `tz` minutes east of UTC. */
export const localDay = (d: Date, tz: number): string =>
  new Date(d.getTime() + tz * 60_000).toISOString().slice(0, 10);

export const shiftDay = (day: string, delta: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);

/** The local hour (0–23) of `d`. */
export const localHour = (d: Date, tz: number): number => new Date(d.getTime() + tz * 60_000).getUTCHours();

const mondayOf = (day: string): string => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return shiftDay(day, -((dow + 6) % 7));
};

export interface Clock {
  tz: number;
  now: Date;
  day: string;
  /** the week's Monday, "YYYY-MM-DD" */
  monday: string;
  /** "w2026-11-02", the same format the client uses */
  week: string;
  dayStart: Date;
  weekStart: Date;
}

export function clockFor(tz: number, now = new Date()): Clock {
  const day = localDay(now, tz);
  const monday = mondayOf(day);
  const instant = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - tz * 60_000);
  return { tz, now, day, monday, week: `w${monday}`, dayStart: instant(day), weekStart: instant(monday) };
}

// ── streak maths ───────────────────────────────────────────────────────────
type Days = ReadonlySet<string>;

/**
 * Consecutive trained days ending today, or yesterday when today isn't trained
 * yet. A protected day bridges the run but doesn't add to it.
 */
export function streakLength(trained: Days, protectedDays: Days, today: string): number {
  let cursor = trained.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  for (let i = 0; i < 1000; i++) {
    if (trained.has(cursor)) n++;
    else if (!protectedDays.has(cursor)) break;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/**
 * The missed days a freeze should cover right now: every uncovered day between
 * the last covered day and yesterday. Empty when the streak is too short to be
 * worth a freeze, or when the freezes on hand can't cover the whole gap (spending
 * them on a streak that dies anyway would just waste them).
 */
export function daysToFreeze(trained: Days, protectedDays: Days, today: string, freezes: number): string[] {
  if (freezes <= 0) return [];
  const gap: string[] = [];
  let cursor = shiftDay(today, -1);
  while (!trained.has(cursor) && !protectedDays.has(cursor)) {
    gap.push(cursor);
    if (gap.length > freezes) return [];
    cursor = shiftDay(cursor, -1);
  }
  if (gap.length === 0) return [];
  if (streakLength(trained, protectedDays, cursor) < FREEZE_MIN_STREAK) return [];
  return gap.reverse();
}

export interface RepairOption {
  /** the missed days a repair would cover, oldest first */
  days: string[];
  /** the streak length once repaired */
  restoresTo: number;
}

/**
 * Whether a recent gap can be repaired: 1–3 missed days, ended within the last
 * 3 days, with a real streak on the far side of it.
 */
export function repairOption(trained: Days, protectedDays: Days, today: string): RepairOption | null {
  const covered = (d: string) => trained.has(d) || protectedDays.has(d);
  let cursor = trained.has(today) ? today : shiftDay(today, -1);
  let sinceGap = 0;
  while (covered(cursor)) {
    sinceGap++;
    if (sinceGap > STREAK_REPAIR.windowDays) return null;
    cursor = shiftDay(cursor, -1);
  }
  const gap: string[] = [];
  while (!covered(cursor)) {
    gap.push(cursor);
    if (gap.length > STREAK_REPAIR.maxGapDays) return null;
    cursor = shiftDay(cursor, -1);
  }
  if (streakLength(trained, protectedDays, cursor) < STREAK_REPAIR.minPriorRun) return null;
  const days = gap.reverse();
  return { days, restoresTo: streakLength(trained, new Set([...protectedDays, ...days]), today) };
}

// ── reading a user's streak ────────────────────────────────────────────────
/** A session only counts toward a streak if real work was logged in it. */
export const WORKED_SESSION = {
  status: "completed",
  performances: { some: { sets: { some: { isWarmup: false, completedAt: { not: null } } } } },
} as const;

export async function streakDays(userId: string, tz: number) {
  const [sessions, protections] = await Promise.all([
    prisma.workoutSession.findMany({ where: { userId, ...WORKED_SESSION }, select: { startedAt: true } }),
    prisma.streakProtection.findMany({ where: { userId }, select: { date: true } }),
  ]);
  return {
    trained: new Set(sessions.map((s) => localDay(s.startedAt, tz))),
    protectedDays: new Set(protections.map((p) => p.date)),
  };
}
