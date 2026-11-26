import { describe, expect, it } from "vitest";
import { dupKey, fedCategory, mapFedEquipment, mapFedMuscle, normalizeFed, selectNew, takenKeys, type FedExercise } from "./free-exercise-db.js";

const sit: FedExercise = { id: "3_4_Sit-Up", name: "3/4 Sit-Up", force: "pull", level: "beginner", mechanic: "compound", equipment: "body only", primaryMuscles: ["abdominals"], secondaryMuscles: [], instructions: ["Lie down.", " "], category: "strength", images: ["3_4_Sit-Up/0.jpg", "3_4_Sit-Up/1.jpg"] };

describe("free-exercise-db mapping", () => {
  it("maps muscles and equipment onto app vocabularies", () => {
    expect(mapFedMuscle("quadriceps")).toBe("quads");
    expect(mapFedMuscle("Middle Back")).toBe("back");
    expect(mapFedMuscle("nope")).toBeNull();
    expect(mapFedEquipment("body only")).toEqual(["bodyweight"]);
    expect(mapFedEquipment("kettlebells")).toEqual(["kettlebell"]);
    expect(mapFedEquipment(null)).toEqual(["bodyweight"]);
    expect(mapFedEquipment("other")).toEqual(["other"]);
  });

  it("normalizes a record", () => {
    const n = normalizeFed(sit);
    expect(n).toMatchObject({ externalId: "fed:3_4_Sit-Up", slug: "fed-3-4-sit-up", category: "core", difficulty: "beginner", primary: ["abs"], isBodyweight: true, trackingType: "reps", bodyPart: "core" });
    expect(n.instructions).toEqual(["Lie down."]);
    expect(n.imageStartUrl).toContain("/exercises/3_4_Sit-Up/0.jpg");
    expect(n.imageEndUrl).toContain("/1.jpg");
  });

  it("derives category, difficulty and tracking type", () => {
    expect(fedCategory({ ...sit, category: "stretching" })).toBe("mobility");
    expect(fedCategory({ ...sit, primaryMuscles: ["hamstrings"] })).toBe("legs");
    expect(fedCategory({ ...sit, primaryMuscles: ["chest"], force: "push" })).toBe("push");
    expect(normalizeFed({ ...sit, level: "expert" }).difficulty).toBe("advanced");
    expect(normalizeFed({ ...sit, force: "static" }).trackingType).toBe("time");
    expect(normalizeFed({ ...sit, category: "cardio" }).trackingType).toBe("cardio");
  });
});

describe("selectNew", () => {
  it("skips names we already have (including aliases) and repeats in the file", () => {
    const taken = takenKeys([{ name: "Barbell Bench Press", aliases: ["Flat bench"] }]);
    const recs: FedExercise[] = [
      { ...sit, id: "a", name: "Barbell bench press" },
      { ...sit, id: "b", name: "Flat Bench" },
      { ...sit, id: "c", name: "Sit-Up" },
      { ...sit, id: "d", name: "sit up" },
      { ...sit, id: "e", name: "Mystery", primaryMuscles: ["unknown"] },
    ];
    const r = selectNew(recs, taken);
    expect(r.add.map((x) => x.name)).toEqual(["Sit-Up"]);
    expect(r.duplicates).toEqual(["Barbell bench press", "Flat Bench", "sit up"]);
    expect(r.noMuscle).toEqual(["Mystery"]);
  });
});

describe("dupKey", () => {
  it("collapses word order, plurals, hyphens and joined words", () => {
    expect(dupKey("Triceps Pushdown")).toBe(dupKey("Tricep push down".replace("push down", "pushdown")));
    expect(dupKey("Cable External Rotation")).toBe(dupKey("External Rotation with Cable"));
    expect(dupKey("Pullups")).toBe(dupKey("Pull-up"));
    expect(dupKey("Battling Ropes")).toBe(dupKey("Battle Ropes"));
  });
  it("keeps genuine variants apart", () => {
    expect(dupKey("Dumbbell Shoulder Press")).not.toBe(dupKey("Seated Dumbbell Shoulder Press"));
    expect(dupKey("Barbell Curl")).not.toBe(dupKey("Dumbbell Curl"));
  });
});
