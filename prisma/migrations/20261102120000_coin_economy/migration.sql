-- AlterTable
ALTER TABLE "User" ADD COLUMN "tzOffsetMin" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN "lifetimeEarned" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WalletTransaction" ADD COLUMN "key" TEXT,
ADD COLUMN "kind" TEXT;

-- Backfill: coins earned so far, or at least what is in the wallet now
UPDATE "Wallet" w SET "lifetimeEarned" = GREATEST(
  w."balance",
  COALESCE((SELECT SUM(t."amount") FROM "WalletTransaction" t WHERE t."walletId" = w."id" AND t."type" = 'earn'), 0)
);

-- CreateTable
CREATE TABLE "UserInventory" (
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserInventory_pkey" PRIMARY KEY ("userId","itemId")
);

-- CreateTable
CREATE TABLE "StreakProtection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreakProtection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeWeek" (
    "userId" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "slots" TEXT[],
    "retired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rerolls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengeWeek_pkey" PRIMARY KEY ("userId","week")
);

-- CreateIndex
CREATE INDEX "WalletTransaction_walletId_kind_createdAt_idx" ON "WalletTransaction"("walletId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_walletId_key_key" ON "WalletTransaction"("walletId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "StreakProtection_userId_date_key" ON "StreakProtection"("userId", "date");

-- AddForeignKey
ALTER TABLE "UserInventory" ADD CONSTRAINT "UserInventory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreakProtection" ADD CONSTRAINT "StreakProtection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeWeek" ADD CONSTRAINT "ChallengeWeek_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
