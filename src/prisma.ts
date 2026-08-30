import { PrismaClient } from "@prisma/client";
import { isProd } from "./env.js";

export const prisma = new PrismaClient({
  log: isProd ? ["error"] : ["query", "warn", "error"],
});

process.on("beforeExit", () => {
  void prisma.$disconnect();
});
