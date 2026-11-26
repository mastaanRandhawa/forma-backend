import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { app, cleanupUsers, dbTests, makeUser, type TestUser } from "./helpers.js";

const STRONG = `Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
2026-01-05 18:30:00,Push,1h 5m,Bench Press (Barbell),1,220,5,0,0,,,8
2026-01-05 18:30:00,Push,1h 5m,Plank,1,0,0,0,60,,,
2026-01-05 18:30:00,Push,1h 5m,Zercher Carry (Sandbag),1,50,0,0,40,,,
2026-01-12 18:00:00,Push,50m,Bench Press (Barbell),1,230,5,0,0,,,8
2026-01-19 18:00:00,Push,50m,Bench Press (Barbell),1,225,5,0,0,,,8`;

const post = (u: TestUser, path: string, body: string, type = "text/csv") =>
  request(app).post(`/api/v1/import${path}`).set(u.auth).set("Content-Type", type).send(body);

describe.skipIf(!dbTests)("importing history", () => {
  let u: TestUser;
  beforeAll(async () => {
    u = await makeUser("import");
  });
  afterAll(cleanupUsers);

  it("a dry run reports what would happen and changes nothing", async () => {
    const r = await post(u, "/workouts?dryRun=true&units=lb", STRONG);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, format: "strong", unitUsed: "lb", workouts: { inFile: 3, new: 3, alreadyHere: 0 } });
    const names = Object.fromEntries(r.body.matches.map((m: any) => [m.name, m.matchedTo]));
    expect(names["Bench Press (Barbell)"]).toBe("Barbell Bench Press");
    expect(names["Plank"]).toBe("Plank");
    expect(names["Zercher Carry (Sandbag)"]).toBeNull();
    expect(r.body.exercises.willCreate).toBe(1);
    expect(await prisma.workoutSession.count({ where: { userId: u.id } })).toBe(0);
  });

  it("warns when the file doesn't say its weight unit", async () => {
    const r = await post(u, "/workouts?dryRun=true", STRONG);
    expect(r.body.warnings.join(" ")).toContain("kilograms");
  });

  it("imports with real dates, converts units, creates the unknown exercise, and rebuilds records in date order", async () => {
    const r = await post(u, "/workouts?units=lb", STRONG);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ imported: 3, createdExercises: 1, skippedSets: 0 });

    const sessions = await prisma.workoutSession.findMany({ where: { userId: u.id }, orderBy: { startedAt: "asc" }, include: { performances: { include: { sets: true, exercise: true } } } });
    expect(sessions.map((s) => s.startedAt.toISOString().slice(0, 10))).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
    expect(sessions[0].status).toBe("completed");
    expect(sessions[0].durationSeconds).toBe(3900);
    const bench = sessions[0].performances.find((p) => p.exercise.slug === "barbell-bench-press")!;
    expect(bench.sets[0].weightKg).toBe(99.79); // 220 lb
    const custom = sessions[0].performances.find((p) => p.exercise.source === "custom")!;
    expect(custom.exercise.ownerUserId).toBe(u.id);
    expect(custom.exercise.name).toBe("Zercher Carry (Sandbag)");

    // records: 220 lb, then 230 lb beats it, then 225 lb doesn't
    const prs = await prisma.personalRecord.findMany({ where: { userId: u.id, recordType: "max_weight", exercise: { slug: "barbell-bench-press" } }, orderBy: { achievedAt: "asc" } });
    expect(prs.map((p) => [Math.round(p.value * 2.2046), p.previousValue ? Math.round(p.previousValue * 2.2046) : null])).toEqual([[220, null], [230, 220]]);
    // the timed plank set became a longest-hold record
    expect(await prisma.personalRecord.count({ where: { userId: u.id, recordType: "max_duration", value: 60 } })).toBe(1);
  });

  it("merges: importing the same file again adds nothing", async () => {
    const r = await post(u, "/workouts?units=lb", STRONG);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ imported: 0, workouts: { new: 0, alreadyHere: 3 } });
    expect(await prisma.workoutSession.count({ where: { userId: u.id } })).toBe(3);
  });

  it("can skip unknown exercises instead of creating them", async () => {
    const other = await makeUser("import-skip");
    const r = await post(other, "/workouts?units=lb&createMissing=false", STRONG);
    expect(r.body).toMatchObject({ imported: 3, createdExercises: 0, skippedSets: 1 });
    expect(await prisma.exercise.count({ where: { ownerUserId: other.id } })).toBe(0);
  });

  it("accepts JSON { csv } and reads Hevy and FitNotes too", async () => {
    const hevy = `title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe\nUpper,"15 Feb 2026, 10:30","15 Feb 2026, 11:20","",Bench Press (Barbell),,"",1,normal,80,5,,,8`;
    const a = await request(app).post("/api/v1/import/workouts?dryRun=true").set(u.auth).send({ csv: hevy });
    expect(a.status).toBe(200);
    expect(a.body.format).toBe("hevy");
    const fit = `Date,Exercise,Category,Weight (kgs),Reps,Distance,Distance Unit,Time\n2026-03-02,Deadlift,Back,140,3,,,`;
    const b = await post(u, "/workouts?dryRun=true", fit);
    expect(b.body.format).toBe("fitnotes");
    expect(b.body.unitUsed).toBe("kg");
  });

  it("refuses files it can't read, empty bodies, and oversized histories", async () => {
    expect((await post(u, "/workouts", "a,b\n1,2")).status).toBe(400);
    expect((await post(u, "/workouts", "")).status).toBe(400);
    const rows = Array.from({ length: 401 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")} ${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00,W${i},1h,Squat (Barbell),1,100,5,0,0,,,`).join("\n");
    const big = await post(u, "/workouts?dryRun=true", `Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE\n${rows}`);
    expect(big.status).toBe(400);
    expect(big.body.error.message).toContain("401");
  });

  it("imports Apple Health body weight, once", async () => {
    const xml = `<HealthData>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2026-01-02 07:00:00 +0000" value="82.4"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" startDate="2026-01-09 07:00:00 +0000" value="180"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-01-09 07:00:00 +0000" value="900"/>
</HealthData>`;
    const dry = await post(u, "/body-weight?dryRun=true", xml, "text/xml");
    expect(dry.body).toMatchObject({ readings: 2, new: 2 });
    const first = await post(u, "/body-weight", xml, "text/xml");
    expect(first.status).toBe(201);
    expect(first.body.imported).toBe(2);
    const again = await post(u, "/body-weight", xml, "text/xml");
    expect(again.body).toMatchObject({ imported: 0, alreadyHere: 2 });
    const list = await request(app).get("/api/v1/progress/measurements").set(u.auth);
    expect(list.body.map((m: any) => m.weightKg).sort()).toEqual([81.65, 82.4]);
    expect((await post(u, "/body-weight", "<HealthData/>", "text/xml")).status).toBe(400);
  });

  it("only touches the caller's own data", async () => {
    const stranger = await makeUser("import-stranger");
    expect(await prisma.workoutSession.count({ where: { userId: stranger.id } })).toBe(0);
    expect(await prisma.bodyMeasurement.count({ where: { userId: stranger.id } })).toBe(0);
  });
});
