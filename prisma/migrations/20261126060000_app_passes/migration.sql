-- Timed passes bought with coins to open locked apps
CREATE TABLE "AppPass" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppPass_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AppPass_userId_expiresAt_idx" ON "AppPass"("userId", "expiresAt");
CREATE UNIQUE INDEX "AppPass_userId_requestId_key" ON "AppPass"("userId", "requestId");

ALTER TABLE "AppPass" ADD CONSTRAINT "AppPass_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
