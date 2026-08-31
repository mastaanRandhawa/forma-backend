-- MFA (TOTP authenticator + recovery codes) was dropped from scope before release.
-- DropForeignKey
ALTER TABLE "MfaRecoveryCode" DROP CONSTRAINT "MfaRecoveryCode_userId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "mfaEnabledAt",
DROP COLUMN "mfaSecret";

-- DropTable
DROP TABLE "MfaRecoveryCode";
