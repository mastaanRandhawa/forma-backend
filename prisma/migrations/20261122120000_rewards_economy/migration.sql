-- Server-authoritative rewards: idempotent grants, streak shields, weekly pledges, user timezone.

ALTER TABLE "User" ADD COLUMN "timezone" TEXT;

ALTER TABLE "Wallet" ADD COLUMN "streakShields" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Wallet" ADD COLUMN "shieldedWeeks" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "WalletTransaction" ADD COLUMN "key" TEXT;
CREATE UNIQUE INDEX "WalletTransaction_walletId_key_key" ON "WalletTransaction"("walletId", "key");

CREATE TYPE "PledgeStatus" AS ENUM ('pending', 'won', 'lost');

CREATE TABLE "WeeklyPledge" (
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
CREATE UNIQUE INDEX "WeeklyPledge_userId_weekStart_key" ON "WeeklyPledge"("userId", "weekStart");
ALTER TABLE "WeeklyPledge" ADD CONSTRAINT "WeeklyPledge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
