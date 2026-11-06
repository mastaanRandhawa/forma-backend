import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";
import { localDay, shiftDay } from "../services/streak.js";

const app = createApp();
const DAY_MS = 86_400_000;

/**
 * The coin economy against a real database: nothing here can mint coins, cap
 * coins or spend coins except through the rules. Needs DATABASE_URL.
 */
describe("coin economy", () => {
  let userId = "";
  let auth = "";
  let exercises: string[] = [];

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: `economy+${Date.now()}@example.com`, password: "Economy-test-1" });
    expect(res.status).toBe(201);
    userId = res.body.user.id;
    auth = `Bearer ${res.body.accessToken}`;
    const verified = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: res.body.devVerificationToken });
    expect(verified.status).toBe(200);

    const made = await Promise.all(
      ["squat", "bench", "row"].map((n) =>
        prisma.exercise.upsert({
          where: { slug: `economy-test-${n}` },
          create: { slug: `economy-test-${n}`, name: `Economy Test ${n}`, category: "test" },
          update: {},
        }),
      ),
    );
    exercises = made.map((e) => e.id);
    await prisma.achievement.upsert({
      where: { key: "first-session" },
      create: { key: "first-session", title: "Day one", detail: "Complete your first workout", icon: "star" },
      update: {},
    });
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.exercise.deleteMany({ where: { slug: { startsWith: "economy-test-" } } }).catch(() => {});
  });

  /** Back to a clean account with `coins` in the wallet, no history, and this weekly target. */
  async function reset(coins = 0, target: number | null = null) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    await prisma.walletTransaction.deleteMany({ where: { walletId: wallet.id } });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balance: coins, lifetimeEarned: coins } });
    await prisma.personalRecord.deleteMany({ where: { userId } });
    await prisma.workoutSession.deleteMany({ where: { userId } });
    await prisma.userInventory.deleteMany({ where: { userId } });
    await prisma.streakProtection.deleteMany({ where: { userId } });
    await prisma.challengeWeek.deleteMany({ where: { userId } });
    await prisma.recoveryCheckin.deleteMany({ where: { userId } });
    await prisma.foodLog.deleteMany({ where: { userId } });
    await prisma.chatMessage.deleteMany({ where: { userId } });
    await prisma.userAchievement.deleteMany({ where: { userId } });
    await prisma.userCustomization.deleteMany({ where: { userId } });
    await prisma.user.update({ where: { id: userId }, data: { tzOffsetMin: 0, trainingFrequencyTarget: target } });
  }
  beforeEach(() => reset());

  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set("Authorization", auth).send(body);
  const get = (path: string) => request(app).get(`/api/v1${path}`).set("Authorization", auth);
  const wallet = () => prisma.wallet.findUniqueOrThrow({ where: { userId } });

  /** A session with completed sets, started `minutes` ago, ready to finish through the API. */
  async function startedSession(sets: number, minutes: number, weightKg = 50, exerciseId = exercises[0]) {
    return prisma.workoutSession.create({
      data: {
        userId,
        name: "Test",
        startedAt: new Date(Date.now() - minutes * 60_000),
        performances: {
          create: {
            exerciseId,
            order: 0,
            sets: {
              create: Array.from({ length: sets }, (_, i) => ({
                setNumber: i + 1,
                weightKg,
                reps: 8,
                completedAt: new Date(),
              })),
            },
          },
        },
      },
    });
  }

  /** A session already finished on an earlier day: `daysAgo` days back, at midday. */
  async function trainedOn(daysAgo: number) {
    await prisma.workoutSession.create({
      data: {
        userId,
        name: "History",
        status: "completed",
        startedAt: new Date(Date.now() - daysAgo * DAY_MS),
        endedAt: new Date(Date.now() - daysAgo * DAY_MS + 3_600_000),
        performances: {
          create: {
            exerciseId: exercises[0],
            order: 0,
            sets: { create: { setNumber: 1, weightKg: 50, reps: 8, completedAt: new Date() } },
          },
        },
      },
    });
  }

  const finish = (id: string) => post(`/sessions/${id}/finish`);

  // ── minting ──────────────────────────────────────────────────────────────
  describe("the client can't mint coins", () => {
    it("settle ignores any amount in the request", async () => {
      const res = await post("/economy/settle", { amount: 100000, label: "free money", key: "x" });
      expect(res.status).toBe(200);
      expect((await wallet()).balance).toBe(5); // the daily visit, and nothing else
    });

    it("the old earn route isn't registered in production", async () => {
      vi.resetModules();
      vi.stubEnv("NODE_ENV", "production");
      try {
        const { storeRouter } = await import("./store.js");
        const paths = storeRouter.stack.flatMap((l: { route?: { path: string } }) => (l.route ? [l.route.path] : []));
        expect(paths).toContain("/wallet");
        expect(paths).not.toContain("/wallet/earn");
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });
  });

  // ── settling ─────────────────────────────────────────────────────────────
  describe("settle", () => {
    it("pays each rule once however often it runs", async () => {
      const first = await post("/economy/settle");
      expect(first.body.rewards.map((r: { kind: string }) => r.kind)).toEqual(["visit"]);
      const again = await post("/economy/settle");
      expect(again.body.rewards).toEqual([]);
      expect((await wallet()).balance).toBe(5);
    });

    it("concurrent settles can't pay the same reward twice", async () => {
      await Promise.all(Array.from({ length: 6 }, () => post("/economy/settle")));
      expect((await wallet()).balance).toBe(5);
    });

    it("changing time zone can't earn a second daily visit", async () => {
      await post("/economy/settle", { tzOffsetMin: -720 });
      await post("/economy/settle", { tzOffsetMin: 840 });
      expect((await wallet()).balance).toBe(5);
    });

    it("rejects an offset no real zone has", async () => {
      expect((await post("/economy/settle", { tzOffsetMin: 5000 })).status).toBe(400);
    });

    it("pays for a recovery check-in and for logging food, once a day", async () => {
      await post("/progress/checkin", { sleepH: 8, sleepQuality: 4, fatigue: 2, soreness: 2 });
      await post("/progress/checkin", { sleepH: 8, sleepQuality: 4, fatigue: 2, soreness: 2 });
      const day = localDay(new Date(), 0);
      const log = (name: string) => post("/food/log", { date: day, mealType: "lunch", quickAdd: { name, calories: 200, protein: 30 } });
      await log("one");
      let res = await post("/economy/settle");
      const kinds = (r: typeof res) => r.body.rewards.map((x: { kind: string }) => x.kind).sort();
      expect(kinds(res)).toEqual(["checkin", "visit"]); // one food item isn't a log yet
      await log("two");
      res = await post("/economy/settle");
      expect(kinds(res)).toEqual(["food"]);
      await log("three");
      expect((await post("/economy/settle")).body.rewards).toEqual([]);
    });

    it("pays for reaching the protein target", async () => {
      await prisma.nutritionGoal.upsert({
        where: { userId },
        create: { userId, proteinGrams: 40 },
        update: { proteinGrams: 40 },
      });
      const day = localDay(new Date(), 0);
      await post("/food/log", { date: day, mealType: "lunch", quickAdd: { name: "a", calories: 100, protein: 25 } });
      await post("/food/log", { date: day, mealType: "lunch", quickAdd: { name: "b", calories: 100, protein: 25 } });
      const res = await post("/economy/settle");
      expect(res.body.rewards.map((r: { kind: string }) => r.kind)).toContain("protein");
      await prisma.nutritionGoal.delete({ where: { userId } });
    });
  });

  // ── workouts ─────────────────────────────────────────────────────────────
  describe("workout rewards", () => {
    it("abandoning a workout pays nothing", async () => {
      const s = await startedSession(10, 40);
      await post(`/sessions/${s.id}/abandon`);
      expect((await wallet()).balance).toBe(0);
    });

    it("a workout finished in seconds pays nothing", async () => {
      const s = await startedSession(10, 0);
      const res = await finish(s.id);
      expect(res.status).toBe(200);
      expect(res.body.economy.skipped).toBe("too_short");
      const paid = res.body.economy.rewards.map((r: { kind: string }) => r.kind);
      expect(paid).not.toContain("workout");
    });

    it("an empty workout pays nothing and doesn't extend a streak", async () => {
      const s = await prisma.workoutSession.create({
        data: { userId, name: "Empty", startedAt: new Date(Date.now() - 40 * 60_000) },
      });
      const res = await finish(s.id);
      expect(res.body.economy.skipped).toBe("too_few_sets");
      expect(res.body.economy.snapshot.streak.current).toBe(0);
    });

    it("pays by working sets, once, even if the finish is retried", async () => {
      const s = await startedSession(16, 45);
      const res = await finish(s.id);
      expect(res.body.economy.rewards).toContainEqual({ amount: 60, label: "Workout complete", kind: "workout" });
      const retry = await finish(s.id);
      expect(retry.status).toBe(200);
      expect(retry.body.economy.rewards.map((r: { kind: string }) => r.kind)).not.toContain("workout");
      const paid = await prisma.walletTransaction.count({ where: { kind: "workout", wallet: { userId } } });
      expect(paid).toBe(1);
    });

    it("stops paying after two workouts in a day", async () => {
      for (let i = 0; i < 3; i++) await finish((await startedSession(5, 30)).id);
      const paid = await prisma.walletTransaction.count({ where: { kind: "workout", wallet: { userId } } });
      expect(paid).toBe(2);
    });

    it("a lift's first log isn't a PR, and one lift pays once however many records it beats", async () => {
      await finish((await startedSession(3, 30, 50)).id);
      expect(await prisma.walletTransaction.count({ where: { kind: "pr", wallet: { userId } } })).toBe(0);
      // heavier, so it beats max weight, estimated 1RM and volume all at once
      await finish((await startedSession(3, 30, 60)).id);
      const prs = await prisma.walletTransaction.findMany({ where: { kind: "pr", wallet: { userId } } });
      expect(prs.map((t) => t.amount)).toEqual([25]);
    });

    it("pays the weekly target only for workouts that qualified", async () => {
      await prisma.user.update({ where: { id: userId }, data: { trainingFrequencyTarget: 2 } });
      await finish((await startedSession(5, 0)).id); // too short
      await finish((await startedSession(5, 30)).id);
      expect(await prisma.walletTransaction.count({ where: { kind: "week", wallet: { userId } } })).toBe(0);
      await finish((await startedSession(5, 30)).id);
      const week = await prisma.walletTransaction.findMany({ where: { kind: "week", wallet: { userId } } });
      expect(week.map((t) => t.amount)).toEqual([50]);
    });

    it("a target of 1 can't reach the weekly reward with one workout", async () => {
      await prisma.user.update({ where: { id: userId }, data: { trainingFrequencyTarget: 1 } });
      await finish((await startedSession(5, 30)).id);
      expect(await prisma.walletTransaction.count({ where: { kind: "week", wallet: { userId } } })).toBe(0);
    });

    it("unlocks and pays a first-session achievement once", async () => {
      await finish((await startedSession(5, 30)).id);
      const paid = await prisma.walletTransaction.findMany({ where: { key: "ach:first-session", wallet: { userId } } });
      expect(paid.map((t) => t.amount)).toEqual([25]);
      await finish((await startedSession(5, 30)).id);
      expect(await prisma.walletTransaction.count({ where: { key: "ach:first-session", wallet: { userId } } })).toBe(1);
    });
  });

  // ── streaks ──────────────────────────────────────────────────────────────
  describe("streak plans", () => {
    const streak = async () => (await get("/economy")).body.streak.current as number;
    const held = async () =>
      (await prisma.userInventory.findUnique({ where: { userId_itemId: { userId, itemId: "cs-freeze" } } }))?.quantity ?? 0;

    it("a rest day in the plan doesn't break a streak, spend a freeze or offer a repair", async () => {
      await reset(1000, 5);
      await prisma.userInventory.create({ data: { userId, itemId: "cs-freeze", quantity: 2 } });
      for (const d of [2, 3, 4]) await trainedOn(d);

      const res = await post("/economy/settle");
      expect(res.body.events).toEqual([]);
      expect(res.body.economy.streak).toEqual({ current: 3, repair: null });
      expect(await held()).toBe(2);
      expect((await get("/dashboard")).body.streakDays).toBe(3);
      expect((await get("/progress/consistency")).body.currentStreak).toBe(3);
    });

    it("more days off than the plan allows still break it", async () => {
      await reset(0, 6);
      for (const d of [4, 5, 6]) await trainedOn(d); // three days off leave at least one miss on any weekdays
      expect(await streak()).toBe(0);
    });

    it("with no plan set, a user is held to the default", async () => {
      for (const d of [2, 3, 4]) await trainedOn(d);
      expect(await streak()).toBe(3);
      expect((await get("/economy/catalog")).body.defaultPlannedDays).toBe(3);
    });

    it("an active program's weekdays are the plan when there's no weekly target", async () => {
      await prisma.trainingProgram.create({
        data: { userId, name: "Test", durationWeeks: 4, preferredWeekdays: [1, 2, 3, 4, 5, 6] },
      });
      for (const d of [4, 5, 6]) await trainedOn(d);
      expect(await streak()).toBe(0);
      await prisma.trainingProgram.deleteMany({ where: { userId } });
    });

    it("raising the target keeps the streak behind you", async () => {
      await reset(0, 3);
      for (const d of [2, 4, 6]) await trainedOn(d);
      expect(await streak()).toBe(3);

      const res = await request(app)
        .patch("/api/v1/me")
        .set("Authorization", auth)
        .send({ trainingFrequencyTarget: 7 });
      expect(res.status).toBe(200);
      expect(await streak()).toBe(3);
      const kept = await prisma.streakProtection.findMany({ where: { userId } });
      expect(kept.every((p) => p.source === "plan")).toBe(true);
      expect(kept.map((p) => p.date).sort()).toEqual([5, 3, 1].map((n) => shiftDay(localDay(new Date(), 0), -n)));
    });

    it("a new target can't revive a streak that's already broken", async () => {
      await reset(0, 7);
      for (const d of [2, 3, 4]) await trainedOn(d);
      expect(await streak()).toBe(0);
      await request(app).patch("/api/v1/me").set("Authorization", auth).send({ trainingFrequencyTarget: 7 });
      expect(await prisma.streakProtection.count({ where: { userId } })).toBe(0);
    });

    it("writes nothing when the new target already allows the run", async () => {
      await reset(0, 5);
      for (const d of [2, 3, 4]) await trainedOn(d);
      await request(app).patch("/api/v1/me").set("Authorization", auth).send({ trainingFrequencyTarget: 3 });
      await request(app).patch("/api/v1/me").set("Authorization", auth).send({ name: "Sam" });
      expect(await streak()).toBe(3);
      expect(await prisma.streakProtection.count({ where: { userId } })).toBe(0);
    });

    it("onboarding again keeps the streak too", async () => {
      await reset(0, 3);
      for (const d of [2, 4, 6]) await trainedOn(d);
      expect((await post("/me/onboarding", { trainingFrequencyTarget: 7 })).status).toBe(200);
      expect(await streak()).toBe(3);
    });
  });

  describe("streak protection", () => {
    const streak = async () => (await get("/economy")).body.streak.current as number;
    const held = async (itemId: string) =>
      (await prisma.userInventory.findUnique({ where: { userId_itemId: { userId, itemId } } }))?.quantity ?? 0;

    // a daily plan makes every day off a miss, whatever day of the week the tests run
    beforeEach(() => reset(0, 7));

    it("without a freeze a missed day breaks the streak", async () => {
      for (const d of [2, 3, 4]) await trainedOn(d);
      expect(await streak()).toBe(0);
    });

    it("a freeze really protects the streak, everywhere it's shown", async () => {
      await reset(500, 7);
      for (const d of [2, 3, 4]) await trainedOn(d);

      const bought = await post("/economy/buy", { itemId: "cs-freeze" });
      expect(bought.status).toBe(201);
      // the missed day was already due, so buying it covers that day straight away
      expect(bought.body.events).toEqual([{ type: "freeze_used", days: [shiftDay(localDay(new Date(), 0), -1)] }]);
      expect(await held("cs-freeze")).toBe(0);
      expect(await streak()).toBe(3);

      expect((await get("/dashboard")).body.streakDays).toBe(3);
      expect((await get("/progress/consistency")).body.currentStreak).toBe(3);
    });

    it("a held freeze fires on its own and only once", async () => {
      await prisma.userInventory.create({ data: { userId, itemId: "cs-freeze", quantity: 2 } });
      for (const d of [2, 3, 4]) await trainedOn(d);
      const first = await post("/economy/settle");
      expect(first.body.events).toHaveLength(1);
      expect(await held("cs-freeze")).toBe(1);
      expect((await post("/economy/settle")).body.events).toEqual([]);
      expect(await held("cs-freeze")).toBe(1);
      expect(await prisma.streakProtection.count({ where: { userId } })).toBe(1);
    });

    it("concurrent settles can't double-spend a freeze", async () => {
      await prisma.userInventory.create({ data: { userId, itemId: "cs-freeze", quantity: 2 } });
      for (const d of [2, 3, 4]) await trainedOn(d);
      await Promise.all(Array.from({ length: 4 }, () => post("/economy/settle")));
      expect(await held("cs-freeze")).toBe(1);
    });

    it("keeps a freeze it can't use", async () => {
      await prisma.userInventory.create({ data: { userId, itemId: "cs-freeze", quantity: 1 } });
      for (const d of [3, 4, 5]) await trainedOn(d); // two missed days, one freeze
      await post("/economy/settle");
      expect(await held("cs-freeze")).toBe(1);
      expect(await streak()).toBe(0);
    });

    it("a frozen day doesn't add to the streak or reach a milestone", async () => {
      await prisma.userInventory.create({ data: { userId, itemId: "cs-freeze", quantity: 1 } });
      for (const d of [2, 3, 4]) await trainedOn(d);
      await post("/economy/settle");
      expect(await streak()).toBe(3);
      expect(await prisma.walletTransaction.count({ where: { key: "streak:7", wallet: { userId } } })).toBe(0);
    });

    it("pays each streak milestone once, ever", async () => {
      for (const d of [0, 1, 2]) await trainedOn(d);
      await post("/economy/settle");
      await post("/economy/settle");
      const paid = await prisma.walletTransaction.findMany({ where: { kind: "streak", wallet: { userId } } });
      expect(paid.map((t) => [t.key, t.amount])).toEqual([["streak:3", 10]]);
    });

    it("repair charges and restores, and only when there's a streak to save", async () => {
      await reset(1000, 7);
      expect((await post("/economy/streak-repair")).status).toBe(409);
      expect((await wallet()).balance).toBe(1000);

      for (const d of [2, 3, 4, 5]) await trainedOn(d);
      const snapshot = (await get("/economy")).body;
      expect(snapshot.streak.current).toBe(0);
      expect(snapshot.streak.repair).toMatchObject({ restoresTo: 4, price: 450 });

      const res = await post("/economy/streak-repair");
      expect(res.status).toBe(200);
      expect(res.body.economy.streak.current).toBe(4);
      expect(res.body.economy.streak.repair).toBeNull();
      expect((await wallet()).balance).toBeLessThanOrEqual(1000 - 450 + 100); // plus any rewards the settle paid
    });

    it("can't repair twice in a week", async () => {
      await reset(2000, 7);
      for (const d of [2, 3, 4, 5]) await trainedOn(d);
      expect((await post("/economy/streak-repair")).status).toBe(200);
      // break it again, on a different day: the cooldown still applies
      await prisma.streakProtection.updateMany({ where: { userId }, data: { date: "2020-01-01" } });
      const again = await post("/economy/streak-repair");
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/once a week/);
    });

    it("can't repair without the coins", async () => {
      await reset(100, 7);
      for (const d of [2, 3, 4, 5]) await trainedOn(d);
      expect((await post("/economy/streak-repair")).status).toBe(400);
      expect(await prisma.streakProtection.count({ where: { userId } })).toBe(0);
    });
  });

  // ── buying ───────────────────────────────────────────────────────────────
  describe("buying", () => {
    it("refuses an unknown item", async () => {
      expect((await post("/economy/buy", { itemId: "nope" })).status).toBe(404);
    });

    it("enforces the hold limit", async () => {
      await reset(2000);
      expect((await post("/economy/buy", { itemId: "cs-reroll" })).status).toBe(201);
      expect((await post("/economy/buy", { itemId: "cs-reroll" })).status).toBe(201);
      expect((await post("/economy/buy", { itemId: "cs-reroll" })).status).toBe(201);
      expect((await post("/economy/buy", { itemId: "cs-reroll" })).status).toBe(409);
    });

    it("concurrent buys can't beat the hold limit or overdraw", async () => {
      await reset(160);
      const results = await Promise.all(Array.from({ length: 4 }, () => post("/economy/buy", { itemId: "cs-reroll" })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect((await wallet()).balance).toBeGreaterThanOrEqual(0);
      expect((await prisma.userInventory.findUnique({ where: { userId_itemId: { userId, itemId: "cs-reroll" } } }))?.quantity).toBe(2);
    });

    it("charges this week's deal price and rejects a stale one", async () => {
      await reset(5000);
      const { deals } = (await get("/economy")).body as { deals: { itemId: string; price: number; was: number }[] };
      const deal = deals[0];
      expect((await post("/economy/buy", { itemId: deal.itemId, expectedPrice: deal.was })).status).toBe(409);
      const before = (await wallet()).balance;
      const res = await post("/economy/buy", { itemId: deal.itemId, expectedPrice: deal.price });
      expect(res.status).toBe(201);
      const spend = await prisma.walletTransaction.findFirst({ where: { type: "spend", wallet: { userId } } });
      expect(spend?.amount).toBe(deal.price);
      expect(before).toBe(5000);
    });

    it("a bundle grants everything, charges only for what's new, and can't be bought twice", async () => {
      await reset(5000);
      await post("/economy/settle");
      const bought = await post("/customization/buy", { itemId: "fn-mono" });
      expect(bought.status).toBe(201);
      const res = await post("/economy/buy", { itemId: "bn-neon" });
      expect(res.status).toBe(201);
      for (const id of ["fx-scanlines", "t-terminal", "fn-mono", "rs-arcade"]) {
        expect(res.body.customization.owned).toContain(id);
      }
      const spends = await prisma.walletTransaction.findMany({
        where: { type: "spend", wallet: { userId }, label: "Bought Neon Pack" },
      });
      expect(spends.map((t) => t.amount)).toEqual([675]);
      expect((await post("/economy/buy", { itemId: "bn-neon" })).status).toBe(409);
    });

    it("a program unlocks without touching what's equipped", async () => {
      await reset(5000);
      const res = await post("/economy/buy", { itemId: "pl-arms" });
      expect(res.status).toBe(201);
      expect(res.body.customization.owned).toContain("pl-arms");
      expect(Object.values(res.body.customization.equipped)).not.toContain("pl-arms");
      expect((await post("/customization/equip", { itemId: "pl-arms" })).status).toBe(400);
    });

    it("won't put an item in the wrong slot", async () => {
      await reset(5000);
      await post("/economy/buy", { itemId: "rs-bell" });
      expect((await post("/customization/slot", { slot: "frame", itemId: "rs-bell" })).status).toBe(400);
      expect((await post("/customization/slot", { slot: "restSound", itemId: "rs-bell" })).status).toBe(200);
    });
  });

  // ── challenges ───────────────────────────────────────────────────────────
  describe("challenge rerolls", () => {
    it("swaps an unfinished challenge, spends the item, and won't bring it back", async () => {
      await reset(500);
      await post("/economy/buy", { itemId: "cs-reroll" });
      await post("/economy/buy", { itemId: "cs-reroll" });
      await post("/economy/buy", { itemId: "cs-reroll" });
      const before = (await get("/economy")).body.challenges as { id: string }[];
      expect(before).toHaveLength(3);

      const first = await post(`/economy/challenges/${before[0].id}/reroll`);
      expect(first.status).toBe(200);
      const after = first.body.economy.challenges as { id: string }[];
      expect(after.map((c) => c.id)).not.toContain(before[0].id);
      expect(after).toHaveLength(3);
      expect(first.body.economy.inventory["cs-reroll"]).toBe(2);
      expect(first.body.economy.rerollsLeft).toBe(1);

      const second = await post(`/economy/challenges/${after[0].id}/reroll`);
      expect(second.status).toBe(200);
      expect((second.body.economy.challenges as { id: string }[]).map((c) => c.id)).not.toContain(before[0].id);

      // two a week, even with a third in hand
      const third = await post(`/economy/challenges/${second.body.economy.challenges[0].id}/reroll`);
      expect(third.status).toBe(409);
    });

    it("needs a reroll in hand", async () => {
      const { challenges } = (await get("/economy")).body;
      expect((await post(`/economy/challenges/${challenges[0].id}/reroll`)).status).toBe(400);
    });

    it("refuses a challenge that isn't active", async () => {
      await reset(500);
      await post("/economy/buy", { itemId: "cs-reroll" });
      expect((await post("/economy/challenges/not-a-challenge/reroll")).status).toBe(404);
    });
  });

  // ── Kai ──────────────────────────────────────────────────────────────────
  describe("Kai Deep Review", () => {
    it("needs the item, then spends it and saves the review to the chat", async () => {
      expect((await post("/economy/kai-review")).status).toBe(400);

      await reset(500);
      await post("/economy/buy", { itemId: "cs-review" });
      await trainedOn(2);
      const res = await post("/economy/kai-review");
      expect(res.status).toBe(200);
      const headings = res.body.review.sections.map((s: { heading: string }) => s.heading);
      expect(headings).toEqual(["consistency", "volume", "lifts", "records", "balance", "next step"]);
      expect(res.body.economy.inventory["cs-review"]).toBe(0);
      expect(res.body.economy.lastReview.title).toBe("28-day review");

      const chat = await get("/chat");
      expect(chat.body.at(-1).content).toContain("28-day review");
      expect((await post("/economy/kai-review")).status).toBe(400);
    });

    it("an equipped persona is reported for the chat prompt", async () => {
      await reset(1000);
      await post("/economy/buy", { itemId: "ps-drill" });
      const { personaFor } = await import("../services/economy.js");
      expect(await personaFor(userId)).toBe("ps-drill");
    });
  });

  // ── snapshot ─────────────────────────────────────────────────────────────
  describe("the snapshot", () => {
    it("reports caps and lifetime earnings, which spending doesn't lower", async () => {
      await reset(1000);
      await post("/economy/settle");
      await post("/economy/buy", { itemId: "cs-reroll" });
      const body = (await get("/economy")).body;
      expect(body.balance).toBe(945);
      expect(body.lifetimeEarned).toBe(1005);
      const visit = body.caps.find((c: { kind: string }) => c.kind === "visit");
      expect(visit).toEqual({ kind: "visit", today: 1, week: 1, daily: 1, weekly: 7 });
    });

    it("serves the rule table for the drift check", async () => {
      const body = (await get("/economy/catalog")).body;
      expect(body.consumables["cs-freeze"].price).toBe(100);
      expect(body.cosmetics["fr-crown"].price).toBe(3000);
    });
  });
});
