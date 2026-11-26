import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("app passes", () => {
  let u: TestUser;

  const buy = (minutes: number, requestId: string) => request(app).post("/api/v1/rewards/app-pass").set(u.auth).send({ minutes, requestId });
  const state = async () => (await request(app).get("/api/v1/rewards/app-pass").set(u.auth)).body;
  const fund = (balance: number) => prisma.wallet.update({ where: { userId: u.id }, data: { balance } });
  const minutesLeft = (s: { expiresAt: string; serverNow: string }) => Math.round((Date.parse(s.expiresAt) - Date.parse(s.serverNow)) / 60_000);

  beforeAll(async () => {
    u = await makeUser("app-pass");
  });
  afterAll(cleanupUsers);

  it("starts with no pass and lists the options", async () => {
    await fund(0);
    const s = await state();
    expect(s.expiresAt).toBeNull();
    expect(s.options.map((o: { minutes: number; price: number }) => [o.minutes, o.price])).toEqual([[15, 30], [30, 55], [60, 100]]);
  });

  it("refuses a pass the user can't afford, or one that isn't offered", async () => {
    await fund(29);
    expect((await buy(15, "req-poor-0001")).status).toBe(400);
    await fund(1000);
    expect((await buy(999, "req-odd-00001")).status).toBe(400);
    expect((await state()).balance).toBe(1000);
  });

  it("charges once however often the same request is retried", async () => {
    await fund(30);
    const results = await Promise.all([buy(15, "req-same-0001"), buy(15, "req-same-0001"), buy(15, "req-same-0001")]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await buy(15, "req-same-0001")).status).toBe(201);
    const s = await state();
    expect(s.balance).toBe(0);
    expect(minutesLeft(s)).toBe(15);
    expect(await prisma.appPass.count({ where: { userId: u.id } })).toBe(1);
  });

  it("stacks concurrent purchases without overdrawing", async () => {
    await prisma.appPass.deleteMany({ where: { userId: u.id } });
    await fund(110); // enough for two 30-minute passes, not three
    const results = await Promise.all([buy(30, "req-race-0001"), buy(30, "req-race-0002"), buy(30, "req-race-0003")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 400]);
    const s = await state();
    expect(s.balance).toBe(0);
    expect(minutesLeft(s)).toBe(60);
  });

  it("does not let two store purchases at once overdraw the wallet", async () => {
    const items = await prisma.storeItem.findMany({ where: { price: { gt: 0 } }, orderBy: { price: "asc" }, take: 2 });
    expect(items).toHaveLength(2);
    await fund(items[1].price);
    const results = await Promise.all(items.map((i) => request(app).post(`/api/v1/store/items/${i.id}/buy`).set(u.auth).send()));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: u.id } })).balance).toBeGreaterThanOrEqual(0);
  });
});
