import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";

const app = createApp();

/**
 * Concurrent purchases against a real database: coins must never be spent
 * twice, and the balance must never go negative. Needs DATABASE_URL.
 */
describe("purchases under concurrency", () => {
  let userId = "";
  let auth = "";

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: `race+${Date.now()}@example.com`, password: "Race-condition-1" });
    expect(res.status).toBe(201);
    userId = res.body.user.id;
    auth = `Bearer ${res.body.accessToken}`;
    // the app routes require a verified email; outside production register returns the token
    const verified = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: res.body.devVerificationToken });
    expect(verified.status).toBe(200);
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  const setBalance = (balance: number) => prisma.wallet.update({ where: { userId }, data: { balance } });
  const buy = (itemId: string) =>
    request(app).post("/api/v1/customization/buy").set("Authorization", auth).send({ itemId });

  it("two different items that only one can afford: one succeeds, balance never negative", async () => {
    await setBalance(100);
    const results = await Promise.all([buy("bd-spark"), buy("bd-bolt")]); // 100 coins each
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance).toBe(0);
  });

  it("the same item twice at once: charged once", async () => {
    await setBalance(200);
    const results = await Promise.all([buy("fn-mono"), buy("fn-mono")]); // 80 coins
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance).toBe(120);
    const spends = await prisma.walletTransaction.count({
      where: { walletId: wallet.id, type: "spend", label: "Unlocked fn-mono" },
    });
    expect(spends).toBe(1);
  });
});
