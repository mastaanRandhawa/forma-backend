import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, runSession, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("custom exercises", () => {
  let a: TestUser;
  let b: TestUser;
  let mine: { id: string; slug: string };

  beforeAll(async () => {
    a = await makeUser("custom-a");
    b = await makeUser("custom-b");
  });
  afterAll(cleanupUsers);

  it("creates a private exercise with muscles, media and a guide link", async () => {
    const res = await request(app)
      .post("/api/v1/library/exercises")
      .set(a.auth)
      .send({
        name: "Sandbag Shoulder Carry",
        category: "core",
        equipment: ["sandbag"],
        trackingType: "time",
        primaryMuscleKeys: ["abs"],
        secondaryMuscleKeys: ["shoulders"],
        mediaUrl: "https://example.com/me-carrying.mp4",
        guideUrl: "https://example.com/guide",
      });
    expect(res.status).toBe(201);
    mine = res.body;
    expect(res.body.source).toBe("custom");
    expect(res.body.trackingType).toBe("time");
    expect(res.body.mediaKind).toBe("video");
    expect(res.body.slug).toMatch(/^u-.*-sandbag-shoulder-carry$/);
    expect(res.body.muscles.map((m: any) => [m.muscleGroup.key, m.role]).sort()).toEqual([["abs", "primary"], ["shoulders", "secondary"]]);
  });

  it("is visible to its owner only", async () => {
    const own = await request(app).get("/api/v1/library/exercises?mine=true").set(a.auth);
    expect(own.body.items.map((e: any) => e.id)).toContain(mine.id);
    const all = await request(app).get("/api/v1/library/exercises?take=100&q=Sandbag").set(a.auth);
    expect(all.body.items.map((e: any) => e.id)).toContain(mine.id);
    const other = await request(app).get("/api/v1/library/exercises?take=100&q=Sandbag").set(b.auth);
    expect(other.body.items).toHaveLength(0);
    expect((await request(app).get(`/api/v1/library/exercises/${mine.slug}`).set(b.auth)).status).toBe(404);
    expect((await request(app).get(`/api/v1/library/exercises/${mine.slug}`).set(a.auth)).status).toBe(200);
  });

  it("can be used in workouts by its owner, not by someone else", async () => {
    const ok = await request(app).post("/api/v1/workouts").set(a.auth).send({ name: "Carry day", exercises: [{ exerciseId: mine.id, order: 0, targetSets: 3, targetDurationSec: 40 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.exercises[0].targetDurationSec).toBe(40);
    const bad = await request(app).post("/api/v1/workouts").set(b.auth).send({ name: "Steal", exercises: [{ exerciseId: mine.id, order: 0, targetSets: 3 }] });
    expect(bad.status).toBe(400);
    const log = await request(app).post("/api/v1/sessions/log").set(b.auth).send({ startedAt: "2026-02-01T10:00:00Z", performances: [{ exerciseId: mine.id, sets: [{ durationSeconds: 30 }] }] });
    expect(log.status).toBe(400);
  });

  it("only the owner can edit it, and it can't be deleted while in use", async () => {
    expect((await request(app).patch(`/api/v1/library/exercises/${mine.id}`).set(b.auth).send({ name: "Hijack" })).status).toBe(404);
    const edit = await request(app).patch(`/api/v1/library/exercises/${mine.id}`).set(a.auth).send({ name: "Sandbag Carry", primaryMuscleKeys: ["abs", "glutes"] });
    expect(edit.status).toBe(200);
    expect(edit.body.name).toBe("Sandbag Carry");
    expect(edit.body.muscles.filter((m: any) => m.role === "primary")).toHaveLength(2);
    // used in a planned workout now
    expect((await request(app).delete(`/api/v1/library/exercises/${mine.id}`).set(a.auth)).status).toBe(409);
    await prisma.workoutExercise.deleteMany({ where: { exerciseId: mine.id } });
    expect((await request(app).delete(`/api/v1/library/exercises/${mine.id}`).set(a.auth)).status).toBe(204);
  });

  it("cannot edit or delete a shared exercise", async () => {
    const shared = await prisma.exercise.findFirstOrThrow({ where: { ownerUserId: null } });
    expect((await request(app).patch(`/api/v1/library/exercises/${shared.id}`).set(a.auth).send({ name: "Renamed" })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/library/exercises/${shared.id}`).set(a.auth)).status).toBe(404);
  });

  it("refuses insecure links, unknown muscles and empty names", async () => {
    const send = (body: object) => request(app).post("/api/v1/library/exercises").set(a.auth).send(body);
    expect((await send({ name: "Bad link", mediaUrl: "http://example.com/x.gif" })).status).toBe(400);
    expect((await send({ name: "Bad link", guideUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await send({ name: "Bad muscle", primaryMuscleKeys: ["not-a-muscle"] })).status).toBe(400);
    expect((await send({ name: " " })).status).toBe(400);
  });

  it("uses a custom timed exercise in a session like any other", async () => {
    const own = await request(app).post("/api/v1/library/exercises").set(a.auth).send({ name: "Weighted Hang", trackingType: "time" });
    const fin = await runSession(a, own.body.id, [{ durationSeconds: 40 }]);
    expect(fin.personalRecords.map((p: any) => [p.recordType, p.value])).toContainEqual(["max_duration", 40]);
  });
});
