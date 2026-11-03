import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import {
  CUSTOMIZATION_CATALOGUE,
  DEFAULT_EQUIPPED,
  DEFAULT_OWNED,
} from "../data/customization.js";
import {
  BUNDLES,
  bundlePrice,
  challengeById,
  challengeOrder,
  CHECKIN_COINS,
  CONSUMABLES,
  currentPrice,
  dealsFor,
  defaultChallengeSlots,
  EARN_CAPS,
  FOOD_REWARD,
  FREEZE_ID,
  PR_REWARD,
  PROTEIN_COINS,
  REROLL_ID,
  REROLLS_PER_WEEK,
  STREAK_MILESTONES,
  STREAK_REPAIR,
  VISIT_REWARD,
  weekTargetCoins,
  WEEK_TARGET_REWARD,
  workoutCoins,
  type EarnKind,
  type WeekFacts,
} from "../data/economy.js";
import { evaluateAchievements } from "./achievements.js";
import {
  clockFor,
  daysToFreeze,
  localDay,
  localHour,
  repairOption,
  streakDays,
  streakLength,
  WORKED_SESSION,
  type Clock,
} from "./streak.js";
import { grant, lockWallet, paidKeys, type Reward } from "./wallet.js";

/** Something the economy did on the user's behalf that isn't a payout. */
export interface EconomyEvent {
  type: "freeze_used";
  days: string[];
}

export interface WorkoutResult {
  /** why this workout paid nothing, when it qualified for nothing */
  skipped: "too_few_sets" | "too_short" | null;
}

// ── clock ──────────────────────────────────────────────────────────────────
/** The user's clock, remembering their UTC offset when the browser sent one. */
export async function clockForUser(userId: string, tz?: number): Promise<Clock> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tzOffsetMin: true } });
  if (tz != null && tz !== user.tzOffsetMin) {
    await prisma.user.update({ where: { id: userId }, data: { tzOffsetMin: tz } });
  }
  return clockFor(tz ?? user.tzOffsetMin);
}

// ── customization row (what's owned and equipped) ──────────────────────────
type Db = Pick<typeof prisma, "userCustomization">;
export type CzRow = { owned: string[]; equipped: Record<string, string>; updatedAt: Date };

/**
 * Create the row on first touch. Two first requests at once both try to insert;
 * the loser's unique-key error just means the row now exists.
 */
async function ensureRow(userId: string) {
  await prisma.userCustomization
    .upsert({
      where: { userId },
      create: { userId, owned: DEFAULT_OWNED, equipped: DEFAULT_EQUIPPED },
      update: {},
    })
    .catch((err: unknown) => {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    });
}

async function readCustomization(userId: string, db: Db): Promise<CzRow> {
  const row = await db.userCustomization.findUniqueOrThrow({ where: { userId } });
  const owned = Array.from(new Set([...(row.owned as string[]), ...DEFAULT_OWNED]));
  const equipped = { ...DEFAULT_EQUIPPED, ...(row.equipped as Record<string, string>) };
  return { owned, equipped, updatedAt: row.updatedAt };
}

/** Load (creating on first touch) and normalise a user's customization row. */
export async function loadCustomization(userId: string): Promise<CzRow> {
  await ensureRow(userId);
  return readCustomization(userId, prisma);
}

/** The Kai persona a user has equipped, or null for the default voice. */
export async function personaFor(userId: string): Promise<string | null> {
  const row = await prisma.userCustomization.findUnique({ where: { userId }, select: { equipped: true } });
  const id = (row?.equipped as Record<string, string> | undefined)?.persona;
  return id && id !== DEFAULT_EQUIPPED.persona ? id : null;
}

// ── streak freezes ─────────────────────────────────────────────────────────
/**
 * Spend freezes on any days missed since the last covered day. Safe to repeat,
 * and safe to run concurrently: the wallet lock serialises it per user, and the
 * days are re-read under that lock so a second run finds nothing left to cover.
 */
export async function applyFreezes(userId: string, clock: Clock): Promise<string[]> {
  const held = await prisma.userInventory.findUnique({
    where: { userId_itemId: { userId, itemId: FREEZE_ID } },
    select: { quantity: true },
  });
  if (!held?.quantity) return [];
  const before = await streakDays(userId, clock.tz);
  if (!daysToFreeze(before.trained, before.protectedDays, clock.day, held.quantity).length) return [];

  return prisma.$transaction(async (tx) => {
    await lockWallet(tx, userId);
    const fresh = await tx.userInventory.findUnique({
      where: { userId_itemId: { userId, itemId: FREEZE_ID } },
      select: { quantity: true },
    });
    const covered = new Set(
      (await tx.streakProtection.findMany({ where: { userId }, select: { date: true } })).map((p) => p.date),
    );
    const days = daysToFreeze(before.trained, covered, clock.day, fresh?.quantity ?? 0);
    if (!days.length) return [];
    await tx.userInventory.update({
      where: { userId_itemId: { userId, itemId: FREEZE_ID } },
      data: { quantity: { decrement: days.length } },
    });
    await tx.streakProtection.createMany({ data: days.map((date) => ({ userId, date, source: "freeze" })) });
    return days;
  });
}

/** The user's current streak, after any freezes that are now due. */
export async function streakFor(userId: string): Promise<number> {
  const clock = await clockForUser(userId);
  await applyFreezes(userId, clock).catch(() => {});
  const { trained, protectedDays } = await streakDays(userId, clock.tz);
  return streakLength(trained, protectedDays, clock.day);
}

// ── the week's facts, which challenges measure ─────────────────────────────
async function weekFacts(userId: string, clock: Clock): Promise<WeekFacts> {
  const [sessions, prs, foodDays, checkins] = await Promise.all([
    prisma.workoutSession.findMany({
      where: { userId, ...WORKED_SESSION, startedAt: { gte: clock.weekStart } },
      select: {
        startedAt: true,
        durationSeconds: true,
        totalVolumeKg: true,
        muscleActivations: { where: { role: "primary" }, select: { muscleGroupId: true } },
        performances: {
          select: { sets: { where: { isWarmup: false, completedAt: { not: null } }, select: { id: true } } },
        },
      },
    }),
    prisma.personalRecord.findMany({
      where: { userId, achievedAt: { gte: clock.weekStart }, previousValue: { not: null } },
      select: { sessionId: true, exerciseId: true },
    }),
    prisma.foodLog.findMany({
      where: { userId, date: { gte: clock.monday, lte: clock.day } },
      distinct: ["date"],
      select: { date: true },
    }),
    prisma.recoveryCheckin.findMany({
      where: { userId, recordedAt: { gte: clock.weekStart } },
      select: { recordedAt: true },
    }),
  ]);
  const dow = (d: Date) => new Date(localDay(d, clock.tz)).getUTCDay();
  return {
    workouts: sessions.length,
    volumeLb: Math.round(sessions.reduce((n, s) => n + s.totalVolumeKg, 0) * 2.20462),
    earlySessions: sessions.filter((s) => localHour(s.startedAt, clock.tz) < 9).length,
    muscleGroups: new Set(sessions.flatMap((s) => s.muscleActivations.map((m) => m.muscleGroupId))).size,
    workingSets: sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + p.sets.length, 0), 0),
    prs: new Set(prs.map((p) => `${p.sessionId}:${p.exerciseId}`)).size,
    foodDays: foodDays.length,
    checkinDays: new Set(checkins.map((c) => localDay(c.recordedAt, clock.tz))).size,
    weekendSessions: sessions.filter((s) => [0, 6].includes(dow(s.startedAt))).length,
    longSessions: sessions.filter((s) => s.durationSeconds >= 45 * 60).length,
  };
}

async function challengeRow(userId: string, week: string) {
  const row = await prisma.challengeWeek.findUnique({ where: { userId_week: { userId, week } } });
  return row ?? { slots: defaultChallengeSlots(week), retired: [] as string[], rerolls: 0 };
}

// ── settling ───────────────────────────────────────────────────────────────
/**
 * Pay everything the user is owed right now. The client never says what that
 * is: every rule here reads data the server already holds, and repeating a settle
 * pays nothing twice. Called on app open, after a check-in or food log, and when
 * a workout finishes.
 */
export async function settle(userId: string, clock: Clock): Promise<{ rewards: Reward[]; events: EconomyEvent[] }> {
  const events: EconomyEvent[] = [];
  const frozen = await applyFreezes(userId, clock);
  if (frozen.length) events.push({ type: "freeze_used", days: frozen });

  const { day, week } = clock;
  const [user, row, facts, days] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { trainingFrequencyTarget: true } }),
    challengeRow(userId, week),
    weekFacts(userId, clock),
    streakDays(userId, clock.tz),
  ]);
  const streak = streakLength(days.trained, days.protectedDays, day);
  const milestones = Object.entries(STREAK_MILESTONES).filter(([n]) => streak >= Number(n));
  const activeChallenges = row.slots.flatMap((id) => {
    const c = challengeById(id);
    return c && c.measure(facts) >= c.target ? [c] : [];
  });

  // Everything that could pay right now. Most keys have already paid, so read
  // them once and skip those instead of opening a transaction for each.
  const candidates: { kind: EarnKind; key: string; amount: number; label: string; due: () => Promise<boolean> }[] = [
    {
      kind: "visit", key: `visit:${day}`, amount: VISIT_REWARD.coins, label: "Daily check-in",
      // the local date can jump with the time zone, so also require a real gap
      due: async () =>
        (await prisma.walletTransaction.count({
          where: {
            wallet: { userId },
            kind: "visit",
            createdAt: { gt: new Date(clock.now.getTime() - VISIT_REWARD.minGapHours * 3_600_000) },
          },
        })) === 0,
    },
    {
      kind: "checkin", key: `checkin:${day}`, amount: CHECKIN_COINS, label: "Recovery check-in",
      due: async () => (await prisma.recoveryCheckin.count({ where: { userId, recordedAt: { gte: clock.dayStart } } })) > 0,
    },
    {
      kind: "food", key: `food:${day}`, amount: FOOD_REWARD.coins, label: "Food logged",
      due: async () => (await prisma.foodLog.count({ where: { userId, date: day } })) >= FOOD_REWARD.minItems,
    },
    {
      kind: "protein", key: `protein:${day}`, amount: PROTEIN_COINS, label: "Protein target",
      due: async () => {
        const goal = await prisma.nutritionGoal.findUnique({ where: { userId }, select: { proteinGrams: true } });
        if (!goal?.proteinGrams) return false;
        const eaten = await prisma.foodLog.aggregate({ where: { userId, date: day }, _sum: { protein: true } });
        return (eaten._sum.protein ?? 0) >= goal.proteinGrams;
      },
    },
    {
      kind: "week", key: `week:${week}`,
      amount: weekTargetCoins(user.trainingFrequencyTarget ?? 0),
      label: "Weekly training target",
      due: async () => {
        const target = user.trainingFrequencyTarget;
        if (!target) return false;
        // only workouts that qualified for coins count, so empty sessions can't reach it
        const paid = await prisma.walletTransaction.count({
          where: { wallet: { userId }, kind: "workout", createdAt: { gte: clock.weekStart } },
        });
        return paid >= Math.max(target, WEEK_TARGET_REWARD.minTarget);
      },
    },
    ...activeChallenges.map((c) => ({
      kind: "challenge" as const, key: `${c.id}:${week}`, amount: c.reward, label: `Challenge · ${c.title}`,
      due: async () => true,
    })),
    ...milestones.map(([n, coins]) => ({
      kind: "streak" as const, key: `streak:${n}`, amount: coins, label: `${n}-day streak`,
      due: async () => true,
    })),
  ];

  const paid = await paidKeys(userId, candidates.map((c) => c.key));
  const rewards: Reward[] = [];
  for (const { due, ...g } of candidates) {
    if (paid.has(g.key) || !(await due())) continue;
    const reward = await grant(userId, g, clock);
    if (reward) rewards.push(reward);
  }
  // new activity is what moves achievements, so a settle that paid nothing skips them
  if (rewards.length) rewards.push(...(await evaluateAchievements(userId).catch(() => [])));
  return { rewards, events };
}

/**
 * Pay a finished workout and its PRs. The session must be real: enough completed
 * working sets, and enough time on the server's clock, not the one the client sent.
 */
export async function settleWorkout(
  userId: string,
  session: {
    id: string;
    startedAt: Date;
    endedAt: Date | null;
    performances: { sets: { isWarmup: boolean; reps: number | null; completedAt: Date | null }[] }[];
    personalRecords: { exerciseId: string; previousValue: number | null; exercise: { name: string } }[];
  },
  clock: Clock,
): Promise<{ rewards: Reward[] } & WorkoutResult> {
  const workingSets = session.performances
    .flatMap((p) => p.sets)
    .filter((s) => !s.isWarmup && s.completedAt && (s.reps ?? 0) > 0).length;
  const seconds = ((session.endedAt ?? clock.now).getTime() - session.startedAt.getTime()) / 1000;
  const coins = workoutCoins(workingSets, seconds);
  if (coins == null) {
    return { rewards: [], skipped: workingSets < 3 ? "too_few_sets" : "too_short" };
  }

  const rewards: Reward[] = [];
  const paid = await grant(
    userId,
    { kind: "workout", key: `workout:${session.id}`, amount: coins, label: "Workout complete" },
    clock,
  );
  if (paid) rewards.push(paid);

  // A lift's first log has no previous value, so it's a baseline and not a PR.
  // One lift pays once however many record types it beat.
  const lifts = new Map<string, string>();
  for (const pr of session.personalRecords) {
    if (pr.previousValue != null) lifts.set(pr.exerciseId, pr.exercise.name);
  }
  for (const [exerciseId, name] of [...lifts].slice(0, PR_REWARD.perWorkout)) {
    const reward = await grant(
      userId,
      { kind: "pr", key: `pr:${session.id}:${exerciseId}`, amount: PR_REWARD.coins, label: `PR · ${name}` },
      clock,
    );
    if (reward) rewards.push(reward);
  }
  return { rewards, skipped: null };
}

// ── the snapshot every economy response carries ────────────────────────────
export async function economySnapshot(userId: string, clock: Clock) {
  const [wallet, inventory, row, facts, days, thisWeek, recentRepair, lastReview] = await Promise.all([
    prisma.wallet.findUniqueOrThrow({
      where: { userId },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 25 } },
    }),
    prisma.userInventory.findMany({ where: { userId } }),
    challengeRow(userId, clock.week),
    weekFacts(userId, clock),
    streakDays(userId, clock.tz),
    prisma.walletTransaction.findMany({
      where: { wallet: { userId }, type: "earn", createdAt: { gte: clock.weekStart } },
      select: { kind: true, amount: true, createdAt: true, key: true },
    }),
    prisma.streakProtection.findFirst({
      where: {
        userId,
        source: "repair",
        createdAt: { gt: new Date(clock.now.getTime() - STREAK_REPAIR.cooldownDays * 86_400_000) },
      },
      select: { id: true },
    }),
    prisma.chatMessage.findFirst({
      where: { userId, role: "trainer", richContent: { path: ["kind"], equals: "kai_review" } },
      orderBy: { createdAt: "desc" },
      select: { richContent: true },
    }),
  ]);

  const paidKeysThisWeek = new Set(thisWeek.map((t) => t.key));
  const count = (kind: string, from: Date) =>
    thisWeek.filter((t) => t.kind === kind && t.createdAt >= from).length;

  const repair = repairOption(days.trained, days.protectedDays, clock.day);
  return {
    balance: wallet.balance,
    lifetimeEarned: wallet.lifetimeEarned,
    earnedThisWeek: thisWeek.reduce((n, t) => n + t.amount, 0),
    recent: wallet.transactions.map((t) => ({
      id: t.id, type: t.type, amount: t.amount, label: t.label, kind: t.kind, createdAt: t.createdAt,
    })),
    inventory: Object.fromEntries(inventory.map((i) => [i.itemId, i.quantity])),
    protectedDays: [...days.protectedDays],
    streak: {
      current: streakLength(days.trained, days.protectedDays, clock.day),
      repair: repair && !recentRepair ? { ...repair, price: STREAK_REPAIR.price } : null,
    },
    week: clock.week,
    challenges: row.slots.flatMap((id) => {
      const c = challengeById(id);
      if (!c) return [];
      const current = Math.min(c.target, c.measure(facts));
      return [{
        id: c.id, title: c.title, detail: c.detail, target: c.target, reward: c.reward, unit: c.unit, tone: c.tone,
        current,
        done: current >= c.target,
        paid: paidKeysThisWeek.has(`${c.id}:${clock.week}`),
      }];
    }),
    rerollsLeft: Math.max(0, REROLLS_PER_WEEK - row.rerolls),
    deals: dealsFor(clock.week),
    caps: (Object.keys(EARN_CAPS) as EarnKind[]).flatMap((kind) => {
      const { daily, weekly } = EARN_CAPS[kind];
      if (daily == null && weekly == null) return [];
      return [{ kind, today: count(kind, clock.dayStart), week: count(kind, clock.weekStart), daily, weekly }];
    }),
    lastReview: (lastReview?.richContent as { review?: unknown } | null)?.review ?? null,
  };
}

export type EconomySnapshot = Awaited<ReturnType<typeof economySnapshot>>;

// ── buying ─────────────────────────────────────────────────────────────────
const guardedSpend = async (tx: Prisma.TransactionClient, walletId: string, price: number) => {
  const spent = await tx.wallet.updateMany({
    where: { id: walletId, balance: { gte: price } },
    data: { balance: { decrement: price } },
  });
  if (spent.count === 0) throw badRequest("Not enough coins");
};

const recordSpend = (tx: Prisma.TransactionClient, walletId: string, amount: number, label: string, kind: string) =>
  tx.walletTransaction.create({ data: { walletId, type: "spend", amount, label, kind } });

const checkPrice = (price: number, expected?: number) => {
  // the deal rotated, or the client's copy of the catalogue is stale
  if (expected != null && expected !== price) throw conflict("That price has changed");
};

/**
 * Buy anything in the store. Coins can't be spent twice: every purchase holds the
 * wallet lock, decrements only while the balance covers the price, and writes
 * ownership with a guard on the row it read. Any failure rolls the whole thing back.
 */
export async function purchase(
  userId: string,
  itemId: string,
  clock: Clock,
  expectedPrice?: number,
): Promise<{ owned: string[]; equipped: Record<string, string>; balance: number }> {
  const consumable = CONSUMABLES[itemId];
  const bundle = BUNDLES[itemId];
  const entry = CUSTOMIZATION_CATALOGUE[itemId];
  if (!consumable && !bundle && !entry) throw notFound("Unknown store item");

  // before the transaction: holding the wallet lock while waiting on a second
  // connection could stall every other purchase on a small pool
  await ensureRow(userId);

  return prisma.$transaction(async (tx) => {
    const walletId = await lockWallet(tx, userId);
    const row = await readCustomization(userId, tx);
    let { owned, equipped } = row;

    if (consumable) {
      checkPrice(consumable.price, expectedPrice);
      const held = await tx.userInventory.findUnique({ where: { userId_itemId: { userId, itemId } } });
      if ((held?.quantity ?? 0) >= consumable.maxHold) {
        throw conflict(`You can only hold ${consumable.maxHold} of those`);
      }
      await guardedSpend(tx, walletId, consumable.price);
      await tx.userInventory.upsert({
        where: { userId_itemId: { userId, itemId } },
        create: { userId, itemId, quantity: 1 },
        update: { quantity: { increment: 1 } },
      });
      await recordSpend(tx, walletId, consumable.price, `Bought ${consumable.name}`, "purchase");
    } else {
      let price: number;
      let label: string;
      if (bundle) {
        if (bundle.items.every((id) => owned.includes(id))) throw conflict("Already owned");
        price = bundlePrice(itemId, owned);
        label = `Bought ${bundle.name}`;
        owned = Array.from(new Set([...owned, ...bundle.items]));
      } else {
        if (owned.includes(itemId)) throw conflict("Already owned");
        price = currentPrice(itemId, clock.week);
        label = `Unlocked ${itemId}`;
        owned = [...owned, itemId];
        // a slot item goes straight on; a program has nothing to equip
        if (entry.slot) equipped = { ...equipped, [entry.slot]: itemId };
      }
      checkPrice(price, expectedPrice);
      await guardedSpend(tx, walletId, price);
      const saved = await tx.userCustomization.updateMany({
        where: { userId, updatedAt: row.updatedAt },
        data: { owned, equipped },
      });
      if (saved.count === 0) throw conflict("Customization changed during purchase, try again");
      await recordSpend(tx, walletId, price, label, "purchase");
    }

    const after = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return { owned, equipped, balance: after.balance };
  });
}

// ── using things ───────────────────────────────────────────────────────────
/** Spend a held consumable inside a transaction, or refuse if none are held. */
export async function useConsumable(tx: Prisma.TransactionClient, userId: string, itemId: string) {
  const used = await tx.userInventory.updateMany({
    where: { userId, itemId, quantity: { gte: 1 } },
    data: { quantity: { decrement: 1 } },
  });
  if (used.count === 0) throw badRequest(`You don't have a ${CONSUMABLES[itemId].name}`);
}

/** Swap an unfinished challenge for one the user hasn't already met or retired. */
export async function rerollChallenge(userId: string, challengeId: string, clock: Clock) {
  const facts = await weekFacts(userId, clock);
  await prisma.$transaction(async (tx) => {
    await lockWallet(tx, userId);
    const stored = await tx.challengeWeek.findUnique({ where: { userId_week: { userId, week: clock.week } } });
    const slots = stored?.slots ?? defaultChallengeSlots(clock.week);
    const retired = stored?.retired ?? [];
    const rerolls = stored?.rerolls ?? 0;

    if (!slots.includes(challengeId)) throw notFound("That challenge isn't active this week");
    const current = challengeById(challengeId);
    if (current && current.measure(facts) >= current.target) throw conflict("That challenge is already done");
    if (rerolls >= REROLLS_PER_WEEK) throw conflict("No rerolls left this week");

    const next = challengeOrder(clock.week).find((id) => {
      const c = challengeById(id)!;
      return !slots.includes(id) && !retired.includes(id) && c.measure(facts) < c.target;
    });
    if (!next) throw conflict("No other challenges available this week");

    await useConsumable(tx, userId, REROLL_ID);
    const data = {
      slots: slots.map((id) => (id === challengeId ? next : id)),
      retired: [...retired, challengeId],
      rerolls: rerolls + 1,
    };
    await tx.challengeWeek.upsert({
      where: { userId_week: { userId, week: clock.week } },
      create: { userId, week: clock.week, ...data },
      update: data,
    });
  });
}

/** Charge for and apply a streak repair, but only when one can actually be applied. */
export async function repairStreak(userId: string, clock: Clock) {
  const { trained } = await streakDays(userId, clock.tz);
  await prisma.$transaction(async (tx) => {
    const walletId = await lockWallet(tx, userId);
    const protections = await tx.streakProtection.findMany({ where: { userId } });
    const cutoff = clock.now.getTime() - STREAK_REPAIR.cooldownDays * 86_400_000;
    if (protections.some((p) => p.source === "repair" && p.createdAt.getTime() > cutoff)) {
      throw conflict("You can repair a streak once a week");
    }
    const option = repairOption(trained, new Set(protections.map((p) => p.date)), clock.day);
    if (!option) throw conflict("There's no streak to repair right now");

    await guardedSpend(tx, walletId, STREAK_REPAIR.price);
    await tx.streakProtection.createMany({
      data: option.days.map((date) => ({ userId, date, source: "repair" })),
    });
    await recordSpend(tx, walletId, STREAK_REPAIR.price, "Streak Repair", "purchase");
  });
}
