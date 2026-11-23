/**
 * Rewards — the server-authoritative coin economy.
 *
 * The client never says how many coins to add. It does things (finishes a
 * workout, checks in, logs a goal, claims a quest) and this service decides the
 * amount from the rules in ./rewards-rules. Every grant carries an idempotency
 * key enforced by a unique index on WalletTransaction(walletId, key), so
 * retries, double taps and multiple devices can never pay twice.
 *
 * Shields and pledges settle lazily: whenever rewards state is read (or a
 * workout finishes) we spend any shield a just-ended week needs and close out
 * last week's pledge.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, conflict } from "../lib/errors.js";
import { notify } from "./notify.js";
import { CUSTOMIZATION_CATALOGUE } from "../data/customization.js";
import {
  COINS,
  PLEDGE,
  SHIELD,
  WEEK_STREAK_MILESTONES,
  XP,
  addWeeks,
  computeStreak,
  daysBetween,
  localDate,
  localHour,
  pledgePayout,
  questsFor,
  rankFor,
  shieldsToSpend,
  targetOf,
  validTimezone,
  weekCounts,
  weekOf,
  weekday,
  weeklyDeals,
  workoutCoins,
} from "./rewards-rules.js";

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ── ledger primitives ───────────────────────────────────────────────────────
/** Credit `amount` once per `key`. Returns what was actually paid (0 if already paid). */
export async function grant(userId: string, amount: number, label: string, key: string): Promise<number> {
  if (amount <= 0) return 0;
  try {
    await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: "earn", amount, label, key } });
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount } } });
    });
    return amount;
  } catch (e) {
    if (isUniqueViolation(e)) return 0;
    throw e;
  }
}

/** Debit inside a transaction; throws 400 if the balance can't cover it (race-safe). */
async function debit(tx: Prisma.TransactionClient, userId: string, amount: number, label: string, extra: Prisma.WalletUpdateManyMutationInput = {}, where: Prisma.WalletWhereInput = {}) {
  const res = await tx.wallet.updateMany({ where: { userId, balance: { gte: amount }, ...where }, data: { balance: { decrement: amount }, ...extra } });
  if (res.count === 0) throw badRequest("Not enough coins");
  const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  await tx.walletTransaction.create({ data: { walletId: wallet.id, type: "spend", amount, label } });
  return wallet;
}

// ── context ─────────────────────────────────────────────────────────────────
/** Store the client's IANA timezone when it changes (sent as X-Timezone). */
export async function syncTimezone(userId: string, tz: unknown) {
  if (!validTimezone(tz)) return;
  await prisma.user.updateMany({ where: { id: userId, NOT: { timezone: tz } }, data: { timezone: tz } });
  await prisma.user.updateMany({ where: { id: userId, timezone: null }, data: { timezone: tz } });
}

async function context(userId: string, now = new Date()) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true, trainingFrequencyTarget: true } });
  const tz = user.timezone;
  const thisWeek = weekOf(localDate(now, tz));
  const since = new Date(now.getTime() - 54 * 7 * 86_400_000);
  const [sessions, wallet] = await Promise.all([
    prisma.workoutSession.findMany({ where: { userId, status: "completed", startedAt: { gte: since } }, select: { id: true, startedAt: true }, orderBy: { startedAt: "asc" } }),
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),
  ]);
  const counts = weekCounts(sessions.map((s) => s.startedAt), tz);
  return { tz, now, thisWeek, target: targetOf(user.trainingFrequencyTarget), sessions, counts, wallet };
}
type Ctx = Awaited<ReturnType<typeof context>>;

const streakOf = (c: Ctx, shielded = c.wallet.shieldedWeeks) => computeStreak({ counts: c.counts, thisWeek: c.thisWeek, target: c.target, shielded: new Set(shielded) });

/** Spend shields a just-ended week needs and settle past pledges. Returns the weeks a shield covered. */
async function settle(userId: string, c: Ctx): Promise<string[]> {
  const spend = shieldsToSpend({ counts: c.counts, thisWeek: c.thisWeek, target: c.target, shielded: new Set(c.wallet.shieldedWeeks) }, c.wallet.streakShields);
  if (spend.length) {
    const res = await prisma.wallet.updateMany({
      where: { userId, streakShields: { gte: spend.length } },
      data: { streakShields: { decrement: spend.length }, shieldedWeeks: { push: spend } },
    });
    if (res.count) {
      c.wallet.streakShields -= spend.length;
      c.wallet.shieldedWeeks = [...c.wallet.shieldedWeeks, ...spend];
      void notify(userId, "milestone", "Streak shield used", "A shield covered a missed week — your weekly streak is safe.", "/dashboard").catch(() => {});
    }
  }
  const open = await prisma.weeklyPledge.findMany({ where: { userId, status: "pending", weekStart: { lt: c.thisWeek } } });
  for (const p of open) {
    const won = (c.counts.get(p.weekStart) ?? 0) >= p.target;
    if (won) await grant(userId, pledgePayout(p.stake), "Pledge kept", `pledge:${p.weekStart}`);
    await prisma.weeklyPledge.update({ where: { id: p.id }, data: { status: won ? "won" : "lost", settledAt: new Date() } });
  }
  return spend;
}

// ── event handlers (called by other modules) ────────────────────────────────
export interface RewardLine { label: string; amount: number }
export interface WorkoutRewards {
  coins: number;
  lines: RewardLine[];
  xp: number;
  streak: { weeks: number; target: number; thisWeek: number; passReady: boolean };
  rank: ReturnType<typeof rankFor>;
  targetHit: boolean;
}

/** Pay everything a finished session earns. Safe to call more than once per session. */
export async function onWorkoutFinished(userId: string, sessionId: string): Promise<WorkoutRewards> {
  const session = await prisma.workoutSession.findFirstOrThrow({
    where: { id: sessionId, userId, status: "completed" },
    select: { id: true, startedAt: true, performances: { select: { sets: { select: { completedAt: true, isWarmup: true } } } }, _count: { select: { personalRecords: true } } },
  });
  const c = await context(userId);
  await settle(userId, c);

  const day = localDate(session.startedAt, c.tz);
  const earlier = c.sessions.filter((s) => s.id !== session.id && s.startedAt < session.startedAt);
  const prev = earlier[earlier.length - 1];
  const amounts = workoutCoins({
    workingSets: session.performances.reduce((n, p) => n + p.sets.filter((s) => s.completedAt && !s.isWarmup).length, 0),
    prs: session._count.personalRecords,
    earlierToday: earlier.filter((s) => localDate(s.startedAt, c.tz) === day).length,
    gapDays: prev ? daysBetween(prev.startedAt, session.startedAt) : null,
  });

  const lines: RewardLine[] = [];
  const pay = async (amount: number, label: string, key: string) => {
    const paid = await grant(userId, amount, label, key);
    if (paid) lines.push({ label, amount: paid });
  };
  await pay(amounts.base, "Workout complete", `workout:${session.id}`);
  const prCount = Math.min(COINS.prCap, session._count.personalRecords);
  await pay(amounts.prs, `${prCount} personal record${prCount === 1 ? "" : "s"}`, `workout-pr:${session.id}`);
  await pay(amounts.comeback, "Comeback bonus", `comeback:${session.id}`);

  const week = weekOf(day);
  const targetHit = week === c.thisWeek && (c.counts.get(week) ?? 0) === c.target;
  const streak = streakOf(c);
  if (targetHit) {
    const bonus = WEEK_STREAK_MILESTONES[streak.weeks];
    if (bonus) await pay(bonus, `${streak.weeks}-week streak`, `wstreak:${streak.weeks}:${week}`);
    const pledge = await prisma.weeklyPledge.findUnique({ where: { userId_weekStart: { userId, weekStart: week } } });
    if (pledge?.status === "pending") {
      await pay(pledgePayout(pledge.stake), "Pledge kept", `pledge:${week}`);
      await prisma.weeklyPledge.update({ where: { id: pledge.id }, data: { status: "won", settledAt: new Date() } });
    }
  }

  const { brokeAt: _b, ...publicStreak } = streak;
  return {
    coins: lines.reduce((n, l) => n + l.amount, 0),
    lines,
    xp: XP.perSession + (targetHit ? XP.perTargetWeek : 0),
    streak: publicStreak,
    rank: rankFor(c.counts, c.thisWeek, c.target),
    targetHit,
  };
}

/** Once per local day — rest days earn too. Uses "now", not the check-in's recordedAt, so backdating can't farm it. */
export async function onCheckin(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } });
  return grant(userId, COINS.checkin, "Recovery check-in", `checkin:${localDate(new Date(), user.timezone)}`);
}

/** Once per goal per period, on the transition to completed. */
export const onGoalCompleted = (userId: string, goalId: string, periodKey: string, label: string) =>
  grant(userId, COINS.goal, `Goal · ${label}`, `goal:${goalId}:${periodKey}`);

// ── state ───────────────────────────────────────────────────────────────────
async function questInput(userId: string, c: Ctx, checkinsEnabled: boolean) {
  const weekSessions = c.sessions.filter((s) => weekOf(localDate(s.startedAt, c.tz)) === c.thisWeek);
  const from = new Date(c.now.getTime() - 8 * 86_400_000);
  const [checkins, muscles] = await Promise.all([
    prisma.recoveryCheckin.findMany({ where: { userId, recordedAt: { gte: from } }, select: { recordedAt: true } }),
    prisma.muscleActivation.findMany({ where: { sessionId: { in: weekSessions.map((s) => s.id) }, role: "primary" }, select: { muscleGroupId: true }, distinct: ["muscleGroupId"] }),
  ]);
  return questsFor({
    sessionsThisWeek: weekSessions.length,
    earlySessionsThisWeek: weekSessions.filter((s) => localHour(s.startedAt, c.tz) < 9).length,
    checkinDaysThisWeek: new Set(checkins.map((x) => localDate(x.recordedAt, c.tz)).filter((d) => weekOf(d) === c.thisWeek)).size,
    muscleGroupsThisWeek: muscles.length,
    target: c.target,
    checkinsEnabled,
  });
}

const questKey = (id: string, week: string) => `quest:${id}:${week}`;

export async function rewardsState(userId: string, opts: { checkinsEnabled: boolean }) {
  const c = await context(userId);
  const shieldedNow = await settle(userId, c);
  const streak = streakOf(c);
  const quests = await questInput(userId, c, opts.checkinsEnabled);
  const keys = quests.map((q) => questKey(q.id, c.thisWeek));
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [claimed, pledge, cz, earned] = await Promise.all([
    prisma.walletTransaction.findMany({ where: { walletId: c.wallet.id, key: { in: keys } }, select: { key: true } }),
    prisma.weeklyPledge.findUnique({ where: { userId_weekStart: { userId, weekStart: c.thisWeek } } }),
    prisma.userCustomization.findUnique({ where: { userId } }),
    prisma.walletTransaction.aggregate({ where: { walletId: c.wallet.id, type: "earn", createdAt: { gte: weekAgo } }, _sum: { amount: true } }),
  ]);
  const claimedSet = new Set(claimed.map((t) => t.key));
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  const today = localDate(c.now, c.tz);
  const pledgeBlock = pledgeBlocker(streak.thisWeek, c.target, weekday(today), !!pledge);
  const { brokeAt: _b, ...publicStreak } = streak;
  return {
    week: c.thisWeek,
    nextWeek: addWeeks(c.thisWeek, 1),
    balance: wallet.balance,
    earnedThisWeek: earned._sum.amount ?? 0,
    streak: { ...publicStreak, shieldedWeeks: c.wallet.shieldedWeeks.slice(-6), shieldUsedNow: shieldedNow.length > 0 },
    rank: rankFor(c.counts, c.thisWeek, c.target),
    shields: { held: wallet.streakShields, max: SHIELD.max, price: SHIELD.price },
    pledge: pledge ? { stake: pledge.stake, target: pledge.target, status: pledge.status, payout: pledgePayout(pledge.stake) } : null,
    pledgeOptions: { stakes: PLEDGE.stakes, bonusRate: PLEDGE.bonusRate, available: pledgeBlock === null, reason: pledgeBlock },
    quests: quests.map((q) => {
      const current = Math.min(q.target, q.current);
      return { ...q, current, done: q.current >= q.target, claimed: claimedSet.has(questKey(q.id, c.thisWeek)) };
    }),
    deals: weeklyDeals(userId, c.thisWeek, CUSTOMIZATION_CATALOGUE, (cz?.owned as string[] | undefined) ?? []),
  };
}

function pledgeBlocker(sessionsThisWeek: number, target: number, dow: number, exists: boolean): string | null {
  if (exists) return "You've already pledged this week.";
  if (sessionsThisWeek >= target) return "You've already hit this week's target.";
  // a pledge should be a real commitment, not a sure thing one session away
  if (target - sessionsThisWeek < Math.min(PLEDGE.minRemaining, target)) return "Pledge while you still have most of the week ahead.";
  if (dow > PLEDGE.lastDay) return "Pledges open Monday to Wednesday.";
  return null;
}

// ── actions ─────────────────────────────────────────────────────────────────
export async function claimQuest(userId: string, questId: string, opts: { checkinsEnabled: boolean }) {
  const c = await context(userId);
  const quest = (await questInput(userId, c, opts.checkinsEnabled)).find((q) => q.id === questId);
  if (!quest) throw badRequest("Unknown quest");
  if (quest.current < quest.target) throw badRequest("Quest isn't complete yet");
  const paid = await grant(userId, quest.reward, `Quest · ${quest.title}`, questKey(quest.id, c.thisWeek));
  if (!paid) throw conflict("Already claimed");
  return paid;
}

export async function buyShield(userId: string) {
  await prisma.$transaction(async (tx) => {
    const w = await tx.wallet.findUniqueOrThrow({ where: { userId } });
    if (w.streakShields >= SHIELD.max) throw conflict(`You can hold ${SHIELD.max} shields at most`);
    await debit(tx, userId, SHIELD.price, "Streak shield", { streakShields: { increment: 1 } }, { streakShields: { lt: SHIELD.max } });
  });
}

export async function makePledge(userId: string, stake: number) {
  if (!(PLEDGE.stakes as readonly number[]).includes(stake)) throw badRequest("Pick one of the offered stakes");
  const c = await context(userId);
  const today = localDate(c.now, c.tz);
  const existing = await prisma.weeklyPledge.findUnique({ where: { userId_weekStart: { userId, weekStart: c.thisWeek } } });
  const block = pledgeBlocker(c.counts.get(c.thisWeek) ?? 0, c.target, weekday(today), !!existing);
  if (block) throw badRequest(block);
  try {
    await prisma.$transaction(async (tx) => {
      await debit(tx, userId, stake, "Weekly pledge");
      await tx.weeklyPledge.create({ data: { userId, weekStart: c.thisWeek, stake, target: c.target } });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw badRequest("You've already pledged this week.");
    throw e;
  }
}

/** Price of a customization item for this user right now — this week's deal price if it's on deal. */
export async function priceFor(userId: string, itemId: string, listPrice: number, owned: string[]) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const week = weekOf(localDate(new Date(), user?.timezone));
  const deal = weeklyDeals(userId, week, CUSTOMIZATION_CATALOGUE, owned).find((d) => d.id === itemId);
  return deal ? deal.dealPrice : listPrice;
}
