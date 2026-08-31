-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN     "bodyPart" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "discipline" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "forceType" TEXT,
ADD COLUMN     "formTips" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "imageEndUrl" TEXT,
ADD COLUMN     "imageStartUrl" TEXT,
ADD COLUMN     "isBodyweight" BOOLEAN,
ADD COLUMN     "isUnilateral" BOOLEAN,
ADD COLUMN     "mechanic" TEXT,
ADD COLUMN     "metValue" DOUBLE PRECISION,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'native',
ADD COLUMN     "trainingGoals" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "Exercise_externalId_key" ON "Exercise"("externalId");

-- CreateIndex
CREATE INDEX "Exercise_source_idx" ON "Exercise"("source");

