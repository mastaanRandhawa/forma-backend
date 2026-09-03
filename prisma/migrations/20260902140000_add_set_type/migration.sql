-- CreateEnum
CREATE TYPE "SetType" AS ENUM ('standard', 'warmup', 'amrap', 'dropset', 'cluster');

-- AlterTable
ALTER TABLE "ExerciseSet" ADD COLUMN "setType" "SetType" NOT NULL DEFAULT 'standard';
