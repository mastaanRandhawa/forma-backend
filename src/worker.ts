import cron from "node-cron";
import { prisma } from "./prisma.js";
import { cleanupTokens, purgeDeletedAccounts, dailyNudges, weeklyRollup } from "./jobs/index.js";

/**
 * Background worker. Run as a separate process:  npm run worker
 * (in production, one worker instance; the API scales independently).
 */

const run = (name: string, fn: () => Promise<unknown>) => async () => {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`✔ job ${name} (${Date.now() - started}ms)`, result ?? "");
  } catch (err) {
    console.error(`✖ job ${name} failed`, err);
  }
};

cron.schedule("0 * * * *", run("cleanupTokens", cleanupTokens));
cron.schedule("30 3 * * *", run("purgeDeletedAccounts", purgeDeletedAccounts));
cron.schedule("0 8 * * *", run("dailyNudges", dailyNudges));
cron.schedule("0 7 * * 1", run("weeklyRollup", weeklyRollup));

console.log("🕒 Forma worker started — jobs: cleanupTokens, purgeDeletedAccounts, dailyNudges, weeklyRollup");

process.on("SIGINT", () => void prisma.$disconnect().then(() => process.exit(0)));
process.on("SIGTERM", () => void prisma.$disconnect().then(() => process.exit(0)));
