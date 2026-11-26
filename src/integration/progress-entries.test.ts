import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("edit and delete progress entries", () => {
  let u: TestUser;
  let other: TestUser;
  beforeAll(async () => {
    u = await makeUser("entries");
    other = await makeUser("entries-other");
  });
  afterAll(cleanupUsers);

  const weightOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).weightKg;

  it("fixes a body measurement and keeps the profile weight on the newest entry", async () => {
    const older = await request(app).post("/api/v1/progress/measurements").set(u.auth).send({ weightKg: 80, recordedAt: new Date(Date.now() - 3 * 864e5).toISOString() });
    const newer = await request(app).post("/api/v1/progress/measurements").set(u.auth).send({ weightKg: 88 });
    expect(await weightOf(u.id)).toBe(88);

    const fix = await request(app).patch(`/api/v1/progress/measurements/${newer.body.id}`).set(u.auth).send({ weightKg: 82 });
    expect(fix.status).toBe(200);
    expect(fix.body.weightKg).toBe(82);
    expect(await weightOf(u.id)).toBe(82);

    // deleting the newest falls back to the previous weight
    const del = await request(app).delete(`/api/v1/progress/measurements/${newer.body.id}`).set(u.auth);
    expect(del.status).toBe(204);
    expect(await weightOf(u.id)).toBe(80);
    expect((await request(app).get("/api/v1/progress/measurements").set(u.auth)).body.map((m: any) => m.id)).toEqual([older.body.id]);
  });

  it("rejects empty or invalid edits and other people's entries", async () => {
    const m = await request(app).post("/api/v1/progress/measurements").set(u.auth).send({ weightKg: 70 });
    expect((await request(app).patch(`/api/v1/progress/measurements/${m.body.id}`).set(u.auth).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/v1/progress/measurements/${m.body.id}`).set(u.auth).send({ weightKg: -3 })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/progress/measurements/${m.body.id}`).set(other.auth).send({ weightKg: 71 })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/progress/measurements/${m.body.id}`).set(other.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/progress/measurements/nope`).set(u.auth)).status).toBe(404);
  });

  it("edits and deletes a metric entry", async () => {
    const m = await request(app).post("/api/v1/progress/metrics").set(u.auth).send({ metricType: "bodyweight", value: 70, unit: "kg" });
    expect(m.status).toBe(201);
    const fix = await request(app).patch(`/api/v1/progress/metrics/${m.body.id}`).set(u.auth).send({ value: 71.5 });
    expect(fix.body.value).toBe(71.5);
    expect((await request(app).delete(`/api/v1/progress/metrics/${m.body.id}`).set(other.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/progress/metrics/${m.body.id}`).set(u.auth)).status).toBe(204);
  });

  it("edits and deletes a check-in", async () => {
    const c = await request(app).post("/api/v1/progress/checkin").set(u.auth).send({ sleepH: 6, fatigue: 3 });
    expect(c.status).toBe(201);
    const id = c.body.checkin.id;
    const fix = await request(app).patch(`/api/v1/progress/checkin/${id}`).set(u.auth).send({ sleepH: 8, note: "slept in" });
    expect(fix.status).toBe(200);
    expect(fix.body.checkin).toMatchObject({ sleepH: 8, note: "slept in", fatigue: 3 });
    expect((await request(app).patch(`/api/v1/progress/checkin/${id}`).set(u.auth).send({ fatigue: 9 })).status).toBe(400);
    expect((await request(app).delete(`/api/v1/progress/checkin/${id}`).set(other.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/progress/checkin/${id}`).set(u.auth)).status).toBe(204);
    expect((await request(app).get("/api/v1/progress/checkin").set(u.auth)).body).toHaveLength(0);
  });
});
