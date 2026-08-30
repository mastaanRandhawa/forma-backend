-- CreateEnum
CREATE TYPE "ProgramDayStatus" AS ENUM ('scheduled', 'completed', 'missed', 'rescheduled');

-- CreateEnum
CREATE TYPE "RecommendationKind" AS ENUM ('prescription', 'deload', 'readiness_adjustment', 'swap');

-- AlterTable
ALTER TABLE "TrainingProgram"
  ADD COLUMN "preferredWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "startDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProgramDay"
  ADD COLUMN "scheduledDate" TIMESTAMP(3),
  ADD COLUMN "status" "ProgramDayStatus" NOT NULL DEFAULT 'scheduled',
  ADD COLUMN "sessionId" TEXT;

-- AlterTable
ALTER TABLE "ExercisePerformance"
  ADD COLUMN "prescribedWeightKg" DOUBLE PRECISION,
  ADD COLUMN "prescribedReps" INTEGER,
  ADD COLUMN "prescribedRpe" DOUBLE PRECISION,
  ADD COLUMN "prescriptionAuditId" TEXT;

-- AlterTable
ALTER TABLE "DeviceConnection"
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "lastErrorAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RecommendationAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "RecommendationKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "rule" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCheckin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sleepH" DOUBLE PRECISION,
    "sleepQuality" INTEGER,
    "fatigue" INTEGER,
    "soreness" INTEGER,
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExercisePerformance_prescriptionAuditId_key" ON "ExercisePerformance"("prescriptionAuditId");

-- CreateIndex
CREATE INDEX "RecommendationAudit_userId_kind_createdAt_idx" ON "RecommendationAudit"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "RecoveryCheckin_userId_recordedAt_idx" ON "RecoveryCheckin"("userId", "recordedAt");

-- AddForeignKey
ALTER TABLE "ExercisePerformance" ADD CONSTRAINT "ExercisePerformance_prescriptionAuditId_fkey" FOREIGN KEY ("prescriptionAuditId") REFERENCES "RecommendationAudit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationAudit" ADD CONSTRAINT "RecommendationAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCheckin" ADD CONSTRAINT "RecoveryCheckin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
