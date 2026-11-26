import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("strength by muscle", () => {
  let u: TestUser;
  beforeAll(async () => {
    u = await makeUser("muscle");
  });
  afterAll(cleanupUsers);

  it("is all 'never' with no history", async () => {
    const r = await request(app).get("/api/v1/progress/muscle-strength").set(u.auth);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(5);
    expect(r.body.every((m: any) => m.status === "never" && m.lifts.length === 0)).toBe(true);
  });

  it("shows days since and the lifts behind a muscle once it has been trained", async () => {
    const bench = await prisma.exercise.findUniqueOrThrow({ where: { slug: "barbell-bench-press" } });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const log = await request(app).post("/api/v1/sessions/log").set(u.auth).send({
      startedAt: tenDaysAgo,
      performances: [{ exerciseId: bench.id, sets: Array(4).fill({ weightKg: 100, reps: 5 }) }],
    });
    expect(log.status).toBe(201);

    const r = await request(app).get("/api/v1/progress/muscle-strength").set(u.auth);
    const chest = r.body.find((m: any) => m.key === "chest");
    expect(chest.daysSince).toBeGreaterThanOrEqual(9);
    expect(chest.daysSince).toBeLessThanOrEqual(10);
    expect(chest.status).toBe("due");
    expect(chest.lifts[0]).toMatchObject({ slug: "barbell-bench-press", name: "Barbell Bench Press", e1rmKg: 116.7 });
    // something this session didn't work is still untouched
    expect(r.body.some((m: any) => m.status === "never")).toBe(true);
  });

  it("is per user", async () => {
    const other = await makeUser("muscle-other");
    const r = await request(app).get("/api/v1/progress/muscle-strength").set(other.auth);
    expect(r.body.every((m: any) => m.status === "never")).toBe(true);
  });
});
