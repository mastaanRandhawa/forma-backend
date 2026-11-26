-- Timed sets and cardio: how an exercise is logged, how long/far a set went, and
-- records for the longest hold and furthest effort. Safe to re-run.

DO $$ BEGIN
  CREATE TYPE "TrackingType" AS ENUM ('reps', 'time', 'cardio');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "PersonalRecordType" ADD VALUE IF NOT EXISTS 'max_duration';
ALTER TYPE "PersonalRecordType" ADD VALUE IF NOT EXISTS 'max_distance';

ALTER TABLE "Exercise" ADD COLUMN IF NOT EXISTS "trackingType" "TrackingType" NOT NULL DEFAULT 'reps';
ALTER TABLE "ExerciseSet" ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER;
ALTER TABLE "ExerciseSet" ADD COLUMN IF NOT EXISTS "distanceM" DOUBLE PRECISION;
ALTER TABLE "WorkoutExercise" ADD COLUMN IF NOT EXISTS "targetDurationSec" INTEGER;

-- Existing library rows: cardio is its own kind, and static holds (planks, wall sits, stretches) are timed.
UPDATE "Exercise" SET "trackingType" = 'cardio' WHERE "discipline" = 'cardio' AND "trackingType" = 'reps';
UPDATE "Exercise" SET "trackingType" = 'time' WHERE ("forceType" = 'static' OR "slug" = 'plank') AND "trackingType" = 'reps';
