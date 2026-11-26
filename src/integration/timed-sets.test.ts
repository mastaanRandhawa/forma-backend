import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupUsers, dbTests, exerciseBySlug, makeUser, runSession, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("timed sets and cardio", () => {
  let u: TestUser;
  let plank: { id: string; trackingType: string };

  beforeAll(async () => {
    u = await makeUser("timed");
    plank = await exerciseBySlug("plank");
  });
  afterAll(cleanupUsers);

  it("marks the plank as a timed exercise", () => {
    expect(plank.trackingType).toBe("time");
  });

  it("records a longest-hold PR, and only when it is beaten", async () => {
    const first = await runSession(u, plank.id, [{ durationSeconds: 60 }]);
    expect(first.personalRecords.map((p: any) => [p.recordType, p.value])).toContainEqual(["max_duration", 60]);
    // no weight × reps, so no volume and no 1RM
    expect(first.totalVolumeKg).toBe(0);
    expect(first.personalRecords.some((p: any) => p.recordType === "max_1rm_estimate")).toBe(false);

    const shorter = await runSession(u, plank.id, [{ durationSeconds: 45 }]);
    expect(shorter.personalRecords.some((p: any) => p.recordType === "max_duration")).toBe(false);

    const longer = await runSession(u, plank.id, [{ durationSeconds: 75 }, { durationSeconds: 50 }]);
    const pr = longer.personalRecords.find((p: any) => p.recordType === "max_duration");
    expect(pr.value).toBe(75);
    expect(pr.previousValue).toBe(60);
  });

  it("records the furthest distance for a cardio effort", async () => {
    const run = await runSession(u, plank.id, [{ durationSeconds: 600, distanceM: 2000 }]);
    const dist = run.personalRecords.find((p: any) => p.recordType === "max_distance");
    expect(dist.value).toBe(2000);
  });

  it("rejects an absurd duration", async () => {
    const res = await (await import("supertest")).default((await import("./helpers.js")).app)
      .put("/api/v1/sessions/none/performances/none/sets/1")
      .set(u.auth)
      .send({ durationSeconds: 999_999 });
    expect(res.status).toBe(400);
  });
});
