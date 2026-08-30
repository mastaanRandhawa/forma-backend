-- AlterTable
ALTER TABLE "DeviceConnection"
  ADD COLUMN "accessToken" TEXT,
  ADD COLUMN "refreshToken" TEXT,
  ADD COLUMN "tokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "scope" TEXT,
  ADD COLUMN "externalUserId" TEXT;

-- CreateTable
CREATE TABLE "NutritionEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "label" TEXT,
    "calories" INTEGER,
    "proteinG" DOUBLE PRECISION,
    "carbsG" DOUBLE PRECISION,
    "fatG" DOUBLE PRECISION,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NutritionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NutritionEntry_userId_date_idx" ON "NutritionEntry"("userId", "date");

-- AddForeignKey
ALTER TABLE "NutritionEntry" ADD CONSTRAINT "NutritionEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
