-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'coach';

-- CreateTable
CREATE TABLE "KaiMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KaiMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachAthlete" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "CoachAthlete_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KaiMemory_userId_kind_idx" ON "KaiMemory"("userId", "kind");

-- CreateIndex
CREATE INDEX "KaiMemory_userId_createdAt_idx" ON "KaiMemory"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CoachAthlete_coachId_idx" ON "CoachAthlete"("coachId");

-- CreateIndex
CREATE INDEX "CoachAthlete_athleteId_idx" ON "CoachAthlete"("athleteId");

-- CreateIndex
CREATE UNIQUE INDEX "CoachAthlete_coachId_athleteId_key" ON "CoachAthlete"("coachId", "athleteId");

-- AddForeignKey
ALTER TABLE "KaiMemory" ADD CONSTRAINT "KaiMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachAthlete" ADD CONSTRAINT "CoachAthlete_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachAthlete" ADD CONSTRAINT "CoachAthlete_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

