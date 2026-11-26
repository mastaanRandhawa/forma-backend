import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

describe.skipIf(!dbTests)("named progression rules", () => {
  let u: TestUser;
  let bench: string;
  let squat: string;
  let plank: string;

  const api = (m: "get" | "post" | "put", path: string) => request(app)[m](`/api/v1${path}`).set(u.auth);

  /** Start a session from a routine, log the given sets for the first exercise, finish. */
  async function train(workoutId: string, sets: Record<string, unknown>[]) {
    const s = await api("post", "/sessions").send({ workoutId });
    expect(s.status).toBe(201);
    const perf = s.body.performances[0];
    for (let i = 0; i < sets.length; i++) await api("put", `/sessions/${s.body.id}/performances/${perf.id}/sets/${i + 1}`).send({ completed: true, ...sets[i] });
    await api("post", `/sessions/${s.body.id}/finish`).send({});
    return s.body;
  }

  beforeAll(async () => {
    u = await makeUser("rules");
    bench = (await prisma.exercise.findUniqueOrThrow({ where: { slug: "barbell-bench-press" } })).id;
    squat = (await prisma.exercise.findFirstOrThrow({ where: { slug: { contains: "squat" } } })).id;
    plank = (await prisma.exercise.findUniqueOrThrow({ where: { slug: "plank" } })).id;
  });
  afterAll(cleanupUsers);

  it("lists the rules for a picker", async () => {
    const res = await api("get", "/workouts/progression-rules");
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id)).toEqual(["auto", "linear", "greyskull", "double_progression", "added_time"]);
  });

  it("linear: starts at the template weight, adds the increment after a clean session, with a stated reason", async () => {
    const w = await api("post", "/workouts").send({
      name: "5x5",
      progressionRule: "linear",
      exercises: [{ exerciseId: bench, order: 0, targetSets: 5, targetRepsMin: 5, targetRepsMax: 5, targetWeightKg: 60 }],
    });
    expect(w.status).toBe(201);
    expect(w.body.progressionRule).toBe("linear");

    const first = await train(w.body.id, Array(5).fill({ weightKg: 60, reps: 5 }));
    expect(first.performances[0].prescribedWeightKg).toBe(60);

    const second = await train(w.body.id, Array(5).fill({ weightKg: 62.5, reps: 5 }));
    expect(second.performances[0].prescribedWeightKg).toBe(62.5);
    expect(second.performances[0].prescriptionAudit.rule).toBe("linear: all_sets_hit_5_reps → +increment");
    expect(second.performances[0].prescriptionAudit.output.note).toContain("Linear progression");

    // a miss repeats the weight
    const third = await train(w.body.id, [{ weightKg: 65, reps: 5 }, { weightKg: 65, reps: 4 }, { weightKg: 65, reps: 3 }]);
    expect(third.performances[0].prescribedWeightKg).toBe(65);
    const fourth = await train(w.body.id, Array(5).fill({ weightKg: 65, reps: 5 }));
    expect(fourth.performances[0].prescribedWeightKg).toBe(65);
    expect(fourth.performances[0].prescriptionAudit.rule).toBe("linear: missed_reps → repeat");
  });

  it("an exercise's own rule and increment override the routine's", async () => {
    const w = await api("post", "/workouts").send({
      name: "Mixed",
      progressionRule: "linear",
      exercises: [{ exerciseId: squat, order: 0, targetSets: 3, targetRepsMin: 8, targetRepsMax: 12, targetWeightKg: 40, progressionRule: "double_progression", incrementKg: 5 }],
    });
    await train(w.body.id, Array(3).fill({ weightKg: 40, reps: 12 }));
    const next = await api("post", "/sessions").send({ workoutId: w.body.id });
    const p = next.body.performances[0];
    expect(p.prescribedWeightKg).toBe(45); // +5 kg override
    expect(p.prescribedReps).toBe(8); // back to the bottom of the range
    expect(p.prescriptionAudit.rule).toContain("double_progression");
  });

  it("added time: adds seconds to a hold and stores the target duration", async () => {
    const w = await api("post", "/workouts").send({
      name: "Core",
      exercises: [{ exerciseId: plank, order: 0, targetSets: 2, targetDurationSec: 40, progressionRule: "added_time" }],
    });
    const first = await train(w.body.id, [{ durationSeconds: 40 }, { durationSeconds: 42 }]);
    expect(first.performances[0].prescribedDurationSec).toBe(40);
    const next = await api("post", "/sessions").send({ workoutId: w.body.id });
    expect(next.body.performances[0].prescribedDurationSec).toBe(45);
    expect(next.body.performances[0].prescriptionAudit.rule).toBe("added_time: all_sets_hit_40s → +5s");
  });

  it("routines without a rule keep the automatic engine, and editing a routine keeps its rule", async () => {
    const w = await api("post", "/workouts").send({ name: "Auto", exercises: [{ exerciseId: bench, order: 0, targetSets: 3, targetRepsMin: 8, targetRepsMax: 10, targetWeightKg: 50 }] });
    expect(w.body.progressionRule).toBe("auto");
    const s = await api("post", "/sessions").send({ workoutId: w.body.id });
    expect(s.body.performances[0].prescriptionAudit.rule).toMatch(/^(no_history|top_of_range|mid_range|default|missed|rpe|deload)/);

    const lin = await api("post", "/workouts").send({ name: "Keep", progressionRule: "greyskull", exercises: [] });
    const renamed = await api("put", `/workouts/${lin.body.id}`).send({ name: "Keep (renamed)" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.progressionRule).toBe("greyskull");
  });

  it("rejects an unknown rule and a silly increment", async () => {
    expect((await api("post", "/workouts").send({ name: "x1", progressionRule: "magic", exercises: [] })).status).toBe(400);
    const bad = await api("post", "/workouts").send({ name: "x2", exercises: [{ exerciseId: bench, order: 0, targetSets: 3, incrementKg: 500 }] });
    expect(bad.status).toBe(400);
  });
});
