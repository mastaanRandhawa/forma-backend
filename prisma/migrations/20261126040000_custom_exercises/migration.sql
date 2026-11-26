-- Custom exercises: private to their owner, with the owner's own media link and a guide link.
-- Safe to re-run.

ALTER TABLE "Exercise" ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT;
ALTER TABLE "Exercise" ADD COLUMN IF NOT EXISTS "mediaUrl" TEXT;
ALTER TABLE "Exercise" ADD COLUMN IF NOT EXISTS "mediaKind" TEXT;
ALTER TABLE "Exercise" ADD COLUMN IF NOT EXISTS "guideUrl" TEXT;

CREATE INDEX IF NOT EXISTS "Exercise_ownerUserId_idx" ON "Exercise"("ownerUserId");

DO $$ BEGIN
  ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
