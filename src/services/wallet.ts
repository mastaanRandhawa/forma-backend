import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { EARN_CAPS, type EarnKind } from "../data/economy.js";
import { badRequest } from "../lib/errors.js";
import type { Clock } from "./streak.js";

export interface Reward {
  amount: number;
  label: string;
  kind: string;
}

export interface Grant extends Reward {
  kind: EarnKind;
  /** one payout per key, ever */
  key: string;
}

/**
 * Lock the wallet row for the rest of the transaction, so caps and balances are
 * checked and written one request at a time for each user.
 */
export async function lockWallet(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  if (!rows[0]) throw badRequest("No wallet");
  return rows[0].id;
}

/**
 * The only way coins are earned. Pays at most once per key and stops at the
 * rule's daily and weekly caps. Returns the reward, or null when nothing was paid.
 */
export async function grant(userId: string, g: Grant, clock: Clock): Promise<Reward | null> {
  if (g.amount <= 0) return null;
  const caps = EARN_CAPS[g.kind];
  return prisma.$transaction(async (tx) => {
    const walletId = await lockWallet(tx, userId);
    const paid = await tx.walletTransaction.findUnique({
      where: { walletId_key: { walletId, key: g.key } },
      select: { id: true },
    });
    if (paid) return null;

    const paidSince = (from: Date) =>
      tx.walletTransaction.count({ where: { walletId, kind: g.kind, createdAt: { gte: from } } });
    if (caps.daily != null && (await paidSince(clock.dayStart)) >= caps.daily) return null;
    if (caps.weekly != null && (await paidSince(clock.weekStart)) >= caps.weekly) return null;

    await tx.walletTransaction.create({
      data: { walletId, type: "earn", amount: g.amount, label: g.label, kind: g.kind, key: g.key },
    });
    await tx.wallet.update({
      where: { id: walletId },
      data: { balance: { increment: g.amount }, lifetimeEarned: { increment: g.amount } },
    });
    return { amount: g.amount, label: g.label, kind: g.kind };
  });
}

/** Which of these keys have already paid. Lets a settle skip work that does nothing. */
export async function paidKeys(userId: string, keys: string[]): Promise<Set<string>> {
  const rows = await prisma.walletTransaction.findMany({
    where: { wallet: { userId }, key: { in: keys } },
    select: { key: true },
  });
  return new Set(rows.map((r) => r.key as string));
}
