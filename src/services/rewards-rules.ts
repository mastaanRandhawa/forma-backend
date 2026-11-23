/**
 * Rewards rules — pure functions, no database. Everything that decides how many
 * coins something is worth, what a week is, and how streaks / ranks / quests /
 * weekly deals are computed lives here so it can be unit-tested and so the
 * client never decides an amount.
 *
 * Weeks run Monday→Sunday in the user's own timezone and are identified by the
 * local Monday as "YYYY-MM-DD".
 */

const DAY = 86_400_000;

// ── amounts ─────────────────────────────────────────────────────────────────
export const COINS = {
  workoutBase: 40,
  perWorkingSet: 5,
  workoutSetCap: 80, // base + sets tops out at 120
  /** base workout coins pay for this many sessions per local day */
  workoutsPerDay: 2,
  perPr: 50,
  prCap: 3,
  /** first session after a gap this long earns the comeback bonus */
  comebackGapDays: 7,
  comeback: 60,
  checkin: 15,
  goal: 30,
} as const;

/** Paid the week a weekly streak reaches this many weeks (re-earnable after a reset). */
export const WEEK_STREAK_MILESTONES: Record<number, number> = { 2: 60, 4: 120, 8: 220, 12: 320, 26: 450, 52: 600 };

export const SHIELD = { price: 150, max: 2 } as const;
export const PLEDGE = {
  stakes: [50, 100, 200] as const,
  /** a won pledge returns the stake plus this share of it */
  bonusRate: 0.5,
  /** pledges can be made Monday (0) through this local weekday */
  lastDay: 2, // Wednesday
  /** sessions that must still be ahead when pledging (capped at the target) */
  minRemaining: 2,
} as const;
export const DEALS = { count: 3, discount: 0.25 } as const;

export const XP = { perSession: 100, perTargetWeek: 150 } as const;
export const HORIZON_WEEKS = 52;
/** At most one forgiven missed week in any run of this many weeks. */
export const PASS_WINDOW = 4;

export const RANKS = [
  { rank: 1, title: "Rookie", at: 0 },
  { rank: 2, title: "Regular", at: 500 },
  { rank: 3, title: "Committed", at: 1500 },
  { rank: 4, title: "Dedicated", at: 3000 },
  { rank: 5, title: "Relentless", at: 5000 },
  { rank: 6, title: "Elite", at: 8000 },
  { rank: 7, title: "Legend", at: 12000 },
  { rank: 8, title: "Mythic", at: 17000 },
] as const;

// ── local time ──────────────────────────────────────────────────────────────
export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(d: Date, tz?: string | null) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimezone(tz) ? tz : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Local calendar date "YYYY-MM-DD". */
export const localDate = (d: Date, tz?: string | null) => parts(d, tz).date;
export const localHour = (d: Date, tz?: string | null) => parts(d, tz).hour;

const toUtc = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Monday of the week containing a local date. */
export function weekOf(date: string) {
  const t = toUtc(date);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return fromUtc(t - dow * DAY);
}
export const addWeeks = (week: string, n: number) => fromUtc(toUtc(week) + n * 7 * DAY);
/** 0 = Monday … 6 = Sunday */
export const weekday = (date: string) => (new Date(toUtc(date)).getUTCDay() + 6) % 7;
export const daysBetween = (a: Date, b: Date) => Math.abs(b.getTime() - a.getTime()) / DAY;

/** Count sessions per local week. */
export function weekCounts(startedAt: Date[], tz?: string | null) {
  const m = new Map<string, number>();
  for (const d of startedAt) {
    const w = weekOf(localDate(d, tz));
    m.set(w, (m.get(w) ?? 0) + 1);
  }
  return m;
}

export const targetOf = (t: number | null | undefined) => Math.max(1, Math.min(14, t || 3));

// ── streak ──────────────────────────────────────────────────────────────────
export interface StreakInput {
  counts: Map<string, number>;
  thisWeek: string;
  target: number;
  shielded: Set<string>;
}
export interface Streak {
  weeks: number;
  target: number;
  thisWeek: number;
  /** a miss this week would be forgiven by the free pass */
  passReady: boolean;
  /** how many weeks back (0 = last week) the streak broke, or null if it didn't */
  brokeAt: number | null;
}

/**
 * Consecutive weeks on target, newest first. A missed week is covered by a
 * shield already spent on it, else by the free pass (one per PASS_WINDOW weeks),
 * else the streak ends there. This week counts once its target is hit.
 */
export function computeStreak({ counts, thisWeek, target, shielded }: StreakInput): Streak {
  const active = [...counts.entries()].filter(([w, n]) => n > 0 && w < thisWeek).map(([w]) => w).sort();
  const firstActive = active[0];
  let weeks = 0;
  let passAt: number | null = null;
  let brokeAt: number | null = null;
  for (let i = 0; i < HORIZON_WEEKS && firstActive; i++) {
    const w = addWeeks(thisWeek, -(i + 1));
    if (w < firstActive) break;
    const n = counts.get(w) ?? 0;
    if (n >= target) weeks++;
    else if (shielded.has(w)) continue;
    else if (passAt === null || i - passAt >= PASS_WINDOW) passAt = i;
    else {
      brokeAt = i;
      break;
    }
  }
  if (weeks === 0) passAt = null; // nothing to protect, nothing spent
  const now = counts.get(thisWeek) ?? 0;
  if (now >= target) weeks++;
  return { weeks, target, thisWeek: now, passReady: passAt === null || passAt >= PASS_WINDOW - 1, brokeAt };
}

/**
 * Which recent weeks a held shield should cover: a break in the last
 * PASS_WINDOW weeks that hides an older run of target weeks. Returns the week
 * starts to shield (at most `held`), newest first.
 */
export function shieldsToSpend(input: StreakInput, held: number): string[] {
  const spend: string[] = [];
  const shielded = new Set(input.shielded);
  let cur = computeStreak({ ...input, shielded });
  while (spend.length < held && cur.brokeAt !== null && cur.brokeAt < PASS_WINDOW) {
    const w = addWeeks(input.thisWeek, -(cur.brokeAt + 1));
    shielded.add(w);
    const next = computeStreak({ ...input, shielded });
    if (next.weeks <= cur.weeks) break; // nothing older worth saving
    spend.push(w);
    cur = next;
  }
  return spend;
}

// ── rank ────────────────────────────────────────────────────────────────────
export function rankFor(counts: Map<string, number>, thisWeek: string, target: number) {
  const oldest = addWeeks(thisWeek, -(HORIZON_WEEKS - 1));
  let xp = 0;
  for (const [w, n] of counts) if (w >= oldest && w <= thisWeek) xp += n * XP.perSession + (n >= target ? XP.perTargetWeek : 0);
  let current: (typeof RANKS)[number] = RANKS[0];
  for (const r of RANKS) if (xp >= r.at) current = r;
  const next = RANKS.find((r) => r.at > current.at) ?? null;
  return {
    rank: current.rank,
    title: current.title,
    xp,
    next,
    toNext: next ? next.at - xp : 0,
    pct: next ? Math.min(1, (xp - current.at) / (next.at - current.at)) : 1,
  };
}

// ── workout coins ───────────────────────────────────────────────────────────
export interface WorkoutCoinInput {
  workingSets: number;
  prs: number;
  /** sessions already finished earlier on the same local day */
  earlierToday: number;
  /** days since the previous completed session, null if this is the first */
  gapDays: number | null;
}
export function workoutCoins(i: WorkoutCoinInput) {
  const base = i.earlierToday < COINS.workoutsPerDay ? COINS.workoutBase + Math.min(COINS.workoutSetCap, i.workingSets * COINS.perWorkingSet) : 0;
  const prs = Math.min(COINS.prCap, i.prs) * COINS.perPr;
  const comeback = i.gapDays !== null && i.gapDays >= COINS.comebackGapDays ? COINS.comeback : 0;
  return { base, prs, comeback };
}

export const pledgePayout = (stake: number) => stake + Math.round(stake * PLEDGE.bonusRate);

// ── quests ──────────────────────────────────────────────────────────────────
export interface QuestInput {
  sessionsThisWeek: number;
  earlySessionsThisWeek: number;
  checkinDaysThisWeek: number;
  muscleGroupsThisWeek: number;
  target: number;
  checkinsEnabled: boolean;
}
export interface QuestDef {
  id: string;
  title: string;
  detail: string;
  target: number;
  current: number;
  unit: string;
  reward: number;
  tone: "pink" | "cyan" | "lime" | "amber" | "violet";
}
export function questsFor(i: QuestInput): QuestDef[] {
  const t = i.target;
  return [
    { id: "ch-consistency", title: "Show up", detail: `Finish ${t} workout${t > 1 ? "s" : ""} this week`, target: t, current: i.sessionsThisWeek, unit: "workouts", reward: 180, tone: "pink" },
    i.checkinsEnabled
      ? { id: "ch-checkin", title: "Listen in", detail: "Do a recovery check-in on 3 days", target: 3, current: i.checkinDaysThisWeek, unit: "days", reward: 120, tone: "lime" }
      : { id: "ch-early", title: "Early sets", detail: "Train before 9am twice", target: 2, current: i.earlySessionsThisWeek, unit: "sessions", reward: 150, tone: "amber" },
    { id: "ch-explorer", title: "Mix it up", detail: "Train 5 different muscle groups", target: 5, current: i.muscleGroupsThisWeek, unit: "groups", reward: 160, tone: "violet" },
  ];
}

// ── weekly deals ────────────────────────────────────────────────────────────
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * This week's discounted items for one user: a stable pick from the paid
 * catalogue (owned items stay in the pick, flagged, so buying one never
 * reshuffles the rest). Same user + week → same deals, so the price at
 * checkout matches the price shown.
 */
export function weeklyDeals(userId: string, week: string, catalogue: Record<string, { price: number }>, owned: string[]) {
  return Object.entries(catalogue)
    .filter(([, e]) => e.price > 0)
    .map(([id, e]) => ({ id, price: e.price, order: hash(`${userId}:${week}:${id}`) }))
    .sort((a, b) => a.order - b.order)
    .slice(0, DEALS.count)
    .map(({ id, price }) => ({ id, price, dealPrice: Math.round(price * (1 - DEALS.discount)), owned: owned.includes(id) }));
}
