import { describe, expect, it } from "vitest";
import { detectFormat, matchExercise, nameVariants, parseCsv, parseDuration, parseHealthWeights, parseWhen, parseWorkoutCsv } from "./import-parsers.js";

const STRONG = `Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
2026-01-05 18:30:00,"Push, heavy",1h 5m,Bench Press (Barbell),W,60,8,0,0,,,
2026-01-05 18:30:00,"Push, heavy",1h 5m,Bench Press (Barbell),1,100,5,0,0,,,8
2026-01-05 18:30:00,"Push, heavy",1h 5m,Bench Press (Barbell),2,100,5,0,0,,,9
2026-01-05 18:30:00,"Push, heavy",1h 5m,Plank,1,0,0,0,60,,,
2026-01-12 18:00:00,Legs,45m,Squat (Barbell),1,225,5,0,0,,,`;

const HEVY = `title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe
"Upper","15 Jan 2026, 10:30","15 Jan 2026, 11:20","",Bench Press (Barbell),,"",0,warmup,40,10,,,
"Upper","15 Jan 2026, 10:30","15 Jan 2026, 11:20","",Bench Press (Barbell),,"",1,normal,80,5,,,8.5
"Upper","15 Jan 2026, 10:30","15 Jan 2026, 11:20","",Running,,"",0,normal,,,5.2,1500,`;

const FITNOTES = `Date,Exercise,Category,Weight (lbs),Reps,Distance,Distance Unit,Time
2026-02-02,Deadlift,Back,315,3,,,
2026-02-02,Deadlift,Back,315,3,,,
2026-02-02,Rowing,Cardio,,,2000,m,08:30
2026-02-09,Deadlift,Back,320,3,,,`;

describe("csv", () => {
  it("handles quotes, commas and newlines inside quotes, and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","line1\nline2"\n')).toEqual([["a", "b"], ["x, y", "line1\nline2"]]);
    expect(parseCsv('a,"say ""hi"""')).toEqual([["a", 'say "hi"']]);
  });
  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("dates and durations", () => {
  it("reads the formats the apps use", () => {
    expect(parseWhen("2026-01-05 18:30:00")?.toISOString()).toBe("2026-01-05T18:30:00.000Z");
    expect(parseWhen("15 Jan 2026, 10:30")?.toISOString()).toBe("2026-01-15T10:30:00.000Z");
    expect(parseWhen("2026-02-02")?.toISOString()).toBe("2026-02-02T12:00:00.000Z");
    expect(parseWhen("2026-01-05T18:30:00-05:00")?.toISOString()).toBe("2026-01-05T23:30:00.000Z");
    expect(parseWhen("nonsense")).toBeNull();
  });
  it("reads durations", () => {
    expect(parseDuration("1h 5m")).toBe(3900);
    expect(parseDuration("45m")).toBe(2700);
    expect(parseDuration("1:05:00")).toBe(3900);
    expect(parseDuration("08:30")).toBe(510);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("")).toBeNull();
  });
});

describe("format detection", () => {
  it("tells the three apps apart", () => {
    expect(detectFormat(STRONG)).toBe("strong");
    expect(detectFormat(HEVY)).toBe("hevy");
    expect(detectFormat(FITNOTES)).toBe("fitnotes");
    expect(detectFormat("foo,bar\n1,2")).toBeNull();
  });
});

describe("Strong", () => {
  const r = parseWorkoutCsv(STRONG, "auto", "lb");
  it("groups rows into workouts in date order, with duration", () => {
    expect(r.format).toBe("strong");
    expect(r.workouts).toHaveLength(2);
    expect(r.workouts[0].name).toBe("Push, heavy");
    expect(r.workouts[0].durationSeconds).toBe(3900);
    expect(r.workouts[1].startedAt.toISOString()).toBe("2026-01-12T18:00:00.000Z");
  });
  it("converts weights from the chosen unit and flags warm-up sets", () => {
    const bench = r.workouts[0].exercises[0];
    expect(bench.name).toBe("Bench Press (Barbell)");
    expect(bench.sets[0]).toMatchObject({ isWarmup: true, weightKg: 27.22, reps: 8 });
    expect(bench.sets[1]).toMatchObject({ isWarmup: false, weightKg: 45.36, reps: 5, rpe: 8 });
  });
  it("reads timed sets", () => {
    const plank = r.workouts[0].exercises[1];
    expect(plank.sets[0]).toMatchObject({ durationSeconds: 60, reps: null });
  });
  it("keeps kilograms when told so", () => {
    expect(parseWorkoutCsv(STRONG, "strong", "kg").workouts[1].exercises[0].sets[0].weightKg).toBe(225);
  });
});

describe("Hevy", () => {
  const r = parseWorkoutCsv(HEVY);
  it("reads title, times and duration", () => {
    expect(r.format).toBe("hevy");
    expect(r.workouts).toHaveLength(1);
    expect(r.workouts[0].durationSeconds).toBe(3000);
    expect(r.unitInFile).toBe("kg");
  });
  it("reads set types, rpe, distance and time", () => {
    const [bench, run] = r.workouts[0].exercises;
    expect(bench.sets[0].isWarmup).toBe(true);
    expect(bench.sets[1]).toMatchObject({ weightKg: 80, reps: 5, rpe: 8.5 });
    expect(run.sets[0]).toMatchObject({ distanceM: 5200, durationSeconds: 1500 });
  });
});

describe("FitNotes", () => {
  const r = parseWorkoutCsv(FITNOTES);
  it("makes one workout per day and reads the unit from the header", () => {
    expect(r.format).toBe("fitnotes");
    expect(r.unitInFile).toBe("lb");
    expect(r.workouts).toHaveLength(2);
    expect(r.workouts[0].exercises[0].sets).toHaveLength(2);
    expect(r.workouts[0].exercises[0].sets[0].weightKg).toBe(142.88);
  });
  it("reads cardio distance and time", () => {
    const row = r.workouts[0].exercises[1].sets[0];
    expect(row).toMatchObject({ distanceM: 2000, durationSeconds: 510 });
  });
});

describe("bad input", () => {
  it("refuses a file it can't recognise", () => {
    expect(() => parseWorkoutCsv("a,b\n1,2")).toThrow(/doesn't look like/);
  });
  it("reports rows it can't read instead of dropping them silently", () => {
    const r = parseWorkoutCsv("Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps\nnot a date,X,1h,Squat,1,100,5\n", "strong");
    expect(r.workouts).toHaveLength(0);
    expect(r.warnings[0]).toContain("Row 2");
  });
});

describe("matching names to the library", () => {
  const catalog = [
    { id: "1", name: "Barbell Bench Press", aliases: [] },
    { id: "2", name: "Barbell Back Squat", aliases: ["back squat"] },
    { id: "3", name: "Barbell Front Squat", aliases: [] },
    { id: "4", name: "Plank", aliases: ["front plank"] },
    { id: "5", name: "Romanian Deadlift", aliases: [] },
  ];
  it("turns 'Name (Equipment)' into the catalogue order", () => {
    expect(nameVariants("Bench Press (Barbell)")).toEqual(["barbell bench press", "bench press", "bench press barbell"]);
    expect(matchExercise("Bench Press (Barbell)", catalog)?.id).toBe("1");
  });
  it("matches by alias and ignores case and punctuation", () => {
    expect(matchExercise("Back Squat", catalog)?.id).toBe("2");
    expect(matchExercise("FRONT PLANK", catalog)?.id).toBe("4");
    expect(matchExercise("romanian-deadlift", catalog)?.id).toBe("5");
  });
  it("does not guess between several candidates", () => {
    expect(matchExercise("Squat (Barbell)", catalog)).toBeNull(); // back or front? don't pick one
  });
  it("matches a unique superset", () => {
    expect(matchExercise("Barbell Bench", catalog)?.id).toBe("1");
  });
  it("returns null for something unknown", () => {
    expect(matchExercise("Zercher Carry", catalog)).toBeNull();
  });
});

describe("Apple Health body weight", () => {
  const XML = `<?xml version="1.0"?><HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="1200" startDate="2026-01-05 08:00:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" creationDate="2026-01-06 07:00:00 -0700" startDate="2026-01-06 07:00:00 -0700" value="82.4"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Phone" unit="lb" startDate="2026-01-02 07:30:00 +0100" value="180"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="2026-01-03 07:30:00 +0000" value="5"/>
</HealthData>`;
  it("reads only body mass, converts units, sorts by time and drops implausible values", () => {
    const r = parseHealthWeights(XML);
    expect(r).toHaveLength(2);
    expect(r[0].weightKg).toBe(81.65);
    expect(r[0].recordedAt.toISOString()).toBe("2026-01-02T06:30:00.000Z");
    expect(r[1]).toMatchObject({ weightKg: 82.4 });
    expect(r[1].recordedAt.toISOString()).toBe("2026-01-06T14:00:00.000Z");
  });
});
