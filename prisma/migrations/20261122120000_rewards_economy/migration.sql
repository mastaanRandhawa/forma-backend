-- Server-authoritative rewards: idempotent grants, streak shields, weekly pledges, user timezone.
--
-- Written to be re-runnable: some databases already had parts of this (a
-- "key" column on WalletTransaction, or a half-applied earlier attempt), so
-- every step only adds what's missing.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timezone" TEXT;

ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "streakShields" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "shieldedWeeks" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- WalletTransaction.key — reuse a pre-existing column, but make sure it's a
-- nullable TEXT and holds no duplicates per wallet before the unique index.
ALTER TABLE "WalletTransaction" ADD COLUMN IF NOT EXISTS "key" TEXT;
ALTER TABLE "WalletTransaction" ALTER COLUMN "key" TYPE TEXT USING "key"::TEXT;
ALTER TABLE "WalletTransaction" ALTER COLUMN "key" DROP NOT NULL;
UPDATE "WalletTransaction" t SET "key" = NULL
WHERE t."key" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "WalletTransaction" o
    WHERE o."walletId" = t."walletId" AND o."key" = t."key"
      AND (o."createdAt", o."id") < (t."createdAt", t."id")
  );
CREATE UNIQUE INDEX IF NOT EXISTS "WalletTransaction_walletId_key_key" ON "WalletTransaction"("walletId", "key");

DO $$ BEGIN
  CREATE TYPE "PledgeStatus" AS ENUM ('pending', 'won', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "WeeklyPledge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "stake" INTEGER NOT NULL,
    "target" INTEGER NOT NULL,
    "status" "PledgeStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "WeeklyPledge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WeeklyPledge_userId_weekStart_key" ON "WeeklyPledge"("userId", "weekStart");

DO $$ BEGIN
  ALTER TABLE "WeeklyPledge" ADD CONSTRAINT "WeeklyPledge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
