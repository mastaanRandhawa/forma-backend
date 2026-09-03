-- AlterTable: add amrapRepsLogged to ExerciseSet (nullable)
ALTER TABLE "ExerciseSet" ADD COLUMN IF NOT EXISTS "amrapRepsLogged" INTEGER;
