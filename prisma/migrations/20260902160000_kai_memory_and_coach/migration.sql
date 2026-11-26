-- The schema gained the coach role, Kai's memory and coach/athlete links without
-- a migration. Re-runnable: some databases may already have parts of this
-- (created with `db push`).

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'coach' BEFORE 'admin';

CREATE TABLE IF NOT EXISTS "KaiMemory" (
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

CREATE TABLE IF NOT EXISTS "CoachAthlete" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "CoachAthlete_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "KaiMemory_userId_kind_idx" ON "KaiMemory"("userId", "kind");
CREATE INDEX IF NOT EXISTS "KaiMemory_userId_createdAt_idx" ON "KaiMemory"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CoachAthlete_coachId_idx" ON "CoachAthlete"("coachId");
CREATE INDEX IF NOT EXISTS "CoachAthlete_athleteId_idx" ON "CoachAthlete"("athleteId");
CREATE UNIQUE INDEX IF NOT EXISTS "CoachAthlete_coachId_athleteId_key" ON "CoachAthlete"("coachId", "athleteId");

DO $$ BEGIN
  ALTER TABLE "KaiMemory" ADD CONSTRAINT "KaiMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CoachAthlete" ADD CONSTRAINT "CoachAthlete_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CoachAthlete" ADD CONSTRAINT "CoachAthlete_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
