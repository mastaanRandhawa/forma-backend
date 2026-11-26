import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

const day = (iso: string) => new Date(`${iso}T10:00:00Z`).toISOString();

describe.skipIf(!dbTests)("logging and editing finished workouts", () => {
  let u: TestUser;
  let bench: string;
  const sessions: Record<string, string> = {};

  const log = (name: string, iso: string, kg: number, reps = 5) =>
    request(app)
      .post("/api/v1/sessions/log")
      .set(u.auth)
      .send({ name, startedAt: day(iso), durationSeconds: 3000, performances: [{ exerciseId: bench, sets: [{ weightKg: kg, reps }] }] });

  const weightPRs = async () =>
    (await prisma.personalRecord.findMany({ where: { userId: u.id, recordType: "max_weight" }, orderBy: { achievedAt: "asc" }, include: { session: true } })).map(
      (p) => [p.session?.name, p.value, p.previousValue] as const,
    );

  beforeAll(async () => {
    u = await makeUser("edit");
    bench = (await prisma.exercise.findFirstOrThrow({ where: { slug: { contains: "bench" } } })).id;
  });
  afterAll(cleanupUsers);

  it("stores back-dated workouts as finished, with records judged in date order", async () => {
    for (const [name, iso, kg] of [["A", "2026-01-01", 100], ["B", "2026-01-08", 110], ["C", "2026-01-15", 105]] as const) {
      const r = await log(name, iso, kg);
      expect(r.status).toBe(201);
      expect(r.body.status).toBe("completed");
      sessions[name] = r.body.id;
    }
    expect(await weightPRs()).toEqual([["A", 100, null], ["B", 110, 100]]); // C (105) never beat B (110)
  });

  it("slots an older workout in without disturbing later records", async () => {
    const r = await log("Z", "2025-12-20", 90);
    expect(r.status).toBe(201);
    expect(await weightPRs()).toEqual([["Z", 90, null], ["A", 100, 90], ["B", 110, 100]]);
  });

  it("re-reads records when a set in a finished workout is corrected", async () => {
    const perf = await prisma.exercisePerformance.findFirstOrThrow({ where: { sessionId: sessions.B } });
    const res = await request(app).put(`/api/v1/sessions/${sessions.B}/performances/${perf.id}/sets/1`).set(u.auth).send({ weightKg: 95, reps: 5 });
    expect(res.status).toBe(200);
    // B is now lighter than A, so C's 105 becomes the record instead
    expect(await weightPRs()).toEqual([["Z", 90, null], ["A", 100, 90], ["C", 105, 100]]);
    const b = await prisma.workoutSession.findUniqueOrThrow({ where: { id: sessions.B } });
    expect(b.totalVolumeKg).toBe(475);
  });

  it("moves a workout in time and re-judges records", async () => {
    const res = await request(app).patch(`/api/v1/sessions/${sessions.B}`).set(u.auth).send({ startedAt: day("2026-02-01"), name: "B moved" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("B moved");
    expect(await weightPRs()).toEqual([["Z", 90, null], ["A", 100, 90], ["C", 105, 100]]); // B (95) is now after C (105): no record
  });

  it("deletes a workout and its records, and later ones are re-read", async () => {
    const res = await request(app).delete(`/api/v1/sessions/${sessions.C}`).set(u.auth);
    expect(res.status).toBe(204);
    expect(await prisma.workoutSession.count({ where: { id: sessions.C } })).toBe(0);
    // with C gone, B (95, after A's 100) has no weight record either
    expect(await weightPRs()).toEqual([["Z", 90, null], ["A", 100, 90]]);
  });

  it("removes an exercise from a finished workout", async () => {
    const perf = await prisma.exercisePerformance.findFirstOrThrow({ where: { sessionId: sessions.A } });
    const res = await request(app).delete(`/api/v1/sessions/${sessions.A}/performances/${perf.id}`).set(u.auth);
    expect(res.status).toBe(204);
    // without A's 100 kg, B's 95 kg (moved after Z) is a record over Z's 90 kg
    expect(await weightPRs()).toEqual([["Z", 90, null], ["B moved", 95, 90]]);
  });

  it("rejects a future date, an unknown exercise, and editing an unfinished workout", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const a = await request(app).post("/api/v1/sessions/log").set(u.auth).send({ startedAt: future, performances: [{ exerciseId: bench, sets: [{ weightKg: 50, reps: 5 }] }] });
    expect(a.status).toBe(400);
    const b = await request(app).post("/api/v1/sessions/log").set(u.auth).send({ startedAt: day("2026-03-01"), performances: [{ exerciseId: "nope", sets: [{ weightKg: 50, reps: 5 }] }] });
    expect(b.status).toBe(400);
    const live = await request(app).post("/api/v1/sessions").set(u.auth).send({ name: "live" });
    const c = await request(app).patch(`/api/v1/sessions/${live.body.id}`).set(u.auth).send({ name: "x" });
    expect(c.status).toBe(400);
  });

  it("does not let one user touch another's workout", async () => {
    const other = await makeUser("other");
    const r = await request(app).delete(`/api/v1/sessions/${sessions.B}`).set(other.auth);
    expect(r.status).toBe(404);
  });
});
