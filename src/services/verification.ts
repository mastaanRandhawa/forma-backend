import type { VerificationPurpose } from "@prisma/client";
import { prisma } from "../prisma.js";
import { randomToken, sha256 } from "../lib/crypto.js";

const TTL_MS: Record<VerificationPurpose, number> = {
  email_verify: 24 * 3_600_000, // 24h
  email_change: 3_600_000, // 1h
};

/**
 * Mint a one-time email token. Any prior unused token of the same purpose for the
 * user is invalidated first, so only the most recent link works.
 */
export async function issueVerificationToken(
  userId: string,
  purpose: VerificationPurpose,
  newEmail?: string,
): Promise<string> {
  const raw = randomToken(32);
  await prisma.$transaction([
    prisma.verificationToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.verificationToken.create({
      data: {
        userId,
        purpose,
        newEmail: newEmail?.toLowerCase(),
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + TTL_MS[purpose]),
      },
    }),
  ]);
  return raw;
}

export type ConsumeResult =
  | { ok: true; userId: string; newEmail: string | null }
  | { ok: false; reason: "invalid" | "expired" };

/** Validate + burn a token. */
export async function consumeVerificationToken(
  raw: string,
  purpose: VerificationPurpose,
): Promise<ConsumeResult> {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!record || record.purpose !== purpose || record.usedAt) return { ok: false, reason: "invalid" };
  if (record.expiresAt < new Date()) return { ok: false, reason: "expired" };
  await prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
  return { ok: true, userId: record.userId, newEmail: record.newEmail };
}
