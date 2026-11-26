import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("goal target changes", () => {
  let u: TestUser;
  beforeAll(async () => {
    u = await makeUser("goals");
  });
  afterAll(cleanupUsers);

  const get = async (key: string) => (await request(app).get("/api/v1/goals").set(u.auth)).body.find((g: any) => g.key === key);

  it("re-reads completion when the target moves above or below your progress", async () => {
    const make = await request(app).post("/api/v1/goals").set(u.auth).send({ key: "stretch", label: "Stretch", target: 20, unit: "min", cadence: "daily" });
    expect(make.status).toBeLessThan(300);
    const goal = await get("stretch");
    const log = await request(app).post(`/api/v1/goals/${goal.id}/log`).set(u.auth).send({ value: 15, mode: "set" });
    expect(log.body.completed).toBe(false);

    // lowering the target under your progress completes it
    await request(app).post("/api/v1/goals").set(u.auth).send({ key: "stretch", label: "Stretch", target: 10, unit: "min", cadence: "daily" });
    expect(await get("stretch")).toMatchObject({ current: 15, target: 10, completed: true });

    // raising it again un-completes it
    await request(app).post("/api/v1/goals").set(u.auth).send({ key: "stretch", label: "Stretch", target: 30, unit: "min", cadence: "daily" });
    expect(await get("stretch")).toMatchObject({ target: 30, completed: false });
  });
});
