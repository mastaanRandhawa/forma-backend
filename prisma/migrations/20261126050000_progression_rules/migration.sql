-- Named progression rules per routine, with a per-exercise override and increment,
-- and a prescribed duration for timed exercises. Safe to re-run.

DO $$ BEGIN
  CREATE TYPE "ProgressionRule" AS ENUM ('auto', 'linear', 'greyskull', 'double_progression', 'added_time');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Workout" ADD COLUMN IF NOT EXISTS "progressionRule" "ProgressionRule" NOT NULL DEFAULT 'auto';
ALTER TABLE "WorkoutExercise" ADD COLUMN IF NOT EXISTS "progressionRule" "ProgressionRule";
ALTER TABLE "WorkoutExercise" ADD COLUMN IF NOT EXISTS "incrementKg" DOUBLE PRECISION;
ALTER TABLE "ExercisePerformance" ADD COLUMN IF NOT EXISTS "prescribedDurationSec" INTEGER;
