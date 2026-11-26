import { describe, expect, it } from "vitest";
import { buildMuscleStrength, statusFor } from "./muscle-strength.js";

const now = new Date("2026-03-20T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const groups = [
  { id: "chest", key: "chest", name: "Chest", region: "upper" },
  { id: "quads", key: "quads", name: "Quads", region: "lower" },
  { id: "calves", key: "calves", name: "Calves", region: "lower" },
];
const lift = (slug: string, e1rm: number, muscles: string[], at = daysAgo(3)) => ({ exercise: { slug, name: slug, primaryMuscleGroupIds: muscles }, e1rmKg: e1rm, achievedAt: at });

describe("muscle status", () => {
  it("buckets days since training", () => {
    expect([null, 0, 2, 3, 7, 8, 14, 15].map(statusFor)).toEqual(["never", "recovering", "recovering", "ready", "ready", "due", "due", "overdue"]);
  });
});

describe("buildMuscleStrength", () => {
  const rows = buildMuscleStrength(
    groups,
    [
      { muscleGroupId: "chest", at: daysAgo(10) },
      { muscleGroupId: "chest", at: daysAgo(1) },
      { muscleGroupId: "quads", at: daysAgo(9) },
    ],
    [lift("bench", 100, ["chest"]), lift("bench", 110, ["chest"]), lift("incline", 80, ["chest"]), lift("fly", 40, ["chest"]), lift("dips", 60, ["chest"]), lift("squat", 140, ["quads"])],
    now,
  );
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));

  it("uses the most recent session for each muscle", () => {
    expect(by.chest.daysSince).toBe(1);
    expect(by.chest.status).toBe("recovering");
    expect(by.quads.daysSince).toBe(9);
    expect(by.quads.status).toBe("due");
  });
  it("marks a muscle with no sessions as never trained", () => {
    expect(by.calves).toMatchObject({ lastTrainedAt: null, daysSince: null, status: "never", lifts: [] });
  });
  it("lists the best three lifts per muscle, once each, strongest first", () => {
    expect(by.chest.lifts.map((l) => [l.slug, l.e1rmKg])).toEqual([["bench", 110], ["incline", 80], ["dips", 60]]);
  });
  it("only lists a lift under the muscles it works as a prime mover", () => {
    expect(by.quads.lifts.map((l) => l.slug)).toEqual(["squat"]);
  });
  it("never reports negative days", () => {
    const r = buildMuscleStrength(groups, [{ muscleGroupId: "chest", at: new Date(now.getTime() + 3_600_000) }], [], now);
    expect(r[0].daysSince).toBe(0);
  });
});
