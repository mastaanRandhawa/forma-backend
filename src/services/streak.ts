import { prisma } from "../prisma.js";
import { DEFAULT_PLANNED_DAYS, FREEZE_MIN_STREAK, STREAK_REPAIR } from "../data/economy.js";

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
 * The days a week a user plans to train: their weekly target, or the weekdays
 * they've picked when they have no target, or the default when they have neither.
 */
export const plannedDays = (target: number | null | undefined, weekdays: readonly number[] = []): number =>
  Math.min(7, Math.max(1, target || weekdays.length || DEFAULT_PLANNED_DAYS));

/** A stretch of training: its trained days, and the days off it has taken so far. */
interface Run {
  /** its first trained day */
  start: string;
  length: number;
  /** days off it didn't get away with, oldest first. Until they're covered the run isn't live. */
  misses: string[];
}

const startOfWeek = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 1;

/**
 * Follow the calendar from the first trained day to `through`, judging every day
 * off. Planning `plan` days a week leaves 7 − plan rest days in each Monday-to-
 * Sunday week, and any more than that are misses, so a miss is exactly the day the
 * week's target stops being reachable. Protected days use up neither. Training
 * again after a miss starts a new run, with its rest days back for the week.
 */
function follow(trained: Days, protectedDays: Days, through: string, plan: number): { run: Run; broken: Run | null } {
  let run: Run = { start: "", length: 0, misses: [] };
  let broken: Run | null = null;
  let used = 0;
  const first = [...trained].sort()[0];
  if (!first) return { run, broken };
  for (let day = first; day <= through; day = shiftDay(day, 1)) {
    if (startOfWeek(day)) used = 0;
    if (trained.has(day)) {
      if (run.misses.length) {
        broken = run;
        run = { start: "", length: 0, misses: [] };
        used = 0;
      }
      if (!run.length) run.start = day;
      run.length++;
    } else if (!protectedDays.has(day)) {
      if (used < 7 - plan) used++;
      else run.misses.push(day);
    }
  }
  return { run, broken };
}

/**
 * Every day that has to be covered, on top of `days`, for a run begun on `start`
 * to reach `through` unbroken. Covering a miss can bring up more of them, by taking
 * away the fresh start that came after it.
 */
function coverFor(trained: Days, protectedDays: Days, through: string, plan: number, start: string, days: string[] = []) {
  const cover = [...days];
  for (;;) {
    const { run, broken } = follow(trained, new Set([...protectedDays, ...cover]), through, plan);
    const more = [...(broken?.misses ?? []), ...run.misses].filter((d) => d >= start);
    if (!more.length) return cover.sort();
    cover.push(...more);
  }
}

/**
 * Trained days in the current run, including today once it's trained. Rest days
 * in the plan and protected days bridge the run, but neither adds to it.
 */
export function streakLength(trained: Days, protectedDays: Days, today: string, plan: number): number {
  const { run } = follow(trained, protectedDays, shiftDay(today, -1), plan);
  return (run.misses.length ? 0 : run.length) + (trained.has(today) ? 1 : 0);
}

/**
 * The missed days a freeze should cover right now, oldest first. Rest days in the
 * plan need no cover. Empty when the streak is too short to be worth a freeze, or
 * when the freezes on hand can't cover every miss (spending them on a streak that
 * dies anyway would just waste them).
 */
export function daysToFreeze(trained: Days, protectedDays: Days, today: string, freezes: number, plan: number): string[] {
  const { run } = follow(trained, protectedDays, shiftDay(today, -1), plan);
  if (!run.misses.length || run.misses.length > freezes || run.length < FREEZE_MIN_STREAK) return [];
  return run.misses;
}

export interface RepairOption {
  /** the missed days a repair would cover, oldest first */
  days: string[];
  /** the streak length once repaired */
  restoresTo: number;
}

/**
 * Whether a recent break can be repaired: 1–3 missed days, the last of them within
 * the last 3 days, with a real streak on the far side of it.
 */
export function repairOption(trained: Days, protectedDays: Days, today: string, plan: number): RepairOption | null {
  const yesterday = shiftDay(today, -1);
  const { run, broken } = follow(trained, protectedDays, yesterday, plan);
  const behind = run.misses.length ? run : broken;
  if (!behind || behind.length < STREAK_REPAIR.minPriorRun) return null;
  const end = behind.misses[behind.misses.length - 1]!;
  const latest = trained.has(today) ? today : yesterday;
  if (Date.parse(latest) - Date.parse(end) > STREAK_REPAIR.windowDays * DAY_MS) return null;

  const days = coverFor(trained, protectedDays, yesterday, plan, behind.start, behind.misses);
  if (days.length > STREAK_REPAIR.maxGapDays) return null;
  return { days, restoresTo: streakLength(trained, new Set([...protectedDays, ...days]), today, plan) };
}

/** Whether letting today pass untrained would cost the streak, not just use a rest day. */
export function todayCounts(trained: Days, protectedDays: Days, today: string, plan: number): boolean {
  return follow(trained, protectedDays, today, plan).run.misses.includes(today);
}

/**
 * The days to save before switching plans: whatever the new plan would call a miss
 * in the current run, and no more. Rest already taken this week still counts against
 * the new plan, so a switch can't free up rest, and a run that's already broken has
 * nothing to keep.
 */
export function daysToHold(trained: Days, protectedDays: Days, today: string, plan: number, next: number): string[] {
  const yesterday = shiftDay(today, -1);
  const { run } = follow(trained, protectedDays, yesterday, plan);
  if (run.misses.length || !run.length) return [];
  return coverFor(trained, protectedDays, yesterday, next, run.start);
}

// ── reading a user's streak ────────────────────────────────────────────────
/** A session only counts toward a streak if real work was logged in it. */
export const WORKED_SESSION = {
  status: "completed",
  performances: { some: { sets: { some: { isWarmup: false, completedAt: { not: null } } } } },
} as const;

export async function streakDays(userId: string, tz: number) {
  const [sessions, protections, user] = await Promise.all([
    prisma.workoutSession.findMany({ where: { userId, ...WORKED_SESSION }, select: { startedAt: true } }),
    prisma.streakProtection.findMany({ where: { userId }, select: { date: true } }),
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        trainingFrequencyTarget: true,
        programs: { where: { active: true }, orderBy: { createdAt: "desc" }, take: 1, select: { preferredWeekdays: true } },
      },
    }),
  ]);
  return {
    trained: new Set(sessions.map((s) => localDay(s.startedAt, tz))),
    protectedDays: new Set(protections.map((p) => p.date)),
    plan: plannedDays(user.trainingFrequencyTarget, user.programs[0]?.preferredWeekdays),
  };
}
