import { describe, expect, it } from "vitest";
import {
  deriveCategory,
  imageUrl,
  mapDifficulty,
  mapEquipment,
  mapMuscle,
  nameKey,
  normalize,
  type RepDbExercise,
} from "./repdb.js";

describe("RepDB taxonomy mapping", () => {
  it("maps anatomical muscle slugs onto app MuscleGroup keys", () => {
    expect(mapMuscle("pectoralis_major")).toBe("chest");
    expect(mapMuscle("anterior_deltoid")).toBe("shoulders");
    expect(mapMuscle("gluteus_medius")).toBe("glutes");
    expect(mapMuscle("not_a_muscle")).toBeNull();
  });

  it("normalizes equipment, collapsing machines and defaulting bodyweight", () => {
    expect(mapEquipment("barbell")).toEqual(["barbell"]);
    expect(mapEquipment("ez_bar")).toEqual(["barbell"]);
    expect(mapEquipment("loop_band")).toEqual(["bands"]);
    expect(mapEquipment("leg_press")).toEqual(["machine"]);
    expect(mapEquipment("chest_press_machine")).toEqual(["machine"]);
    expect(mapEquipment("pull_up_bar")).toEqual(["bodyweight"]);
    expect(mapEquipment(undefined)).toEqual(["bodyweight"]);
  });

  it("derives a training-split category from RepDB signals", () => {
    expect(deriveCategory({ force_type: "push", body_part: "chest" })).toBe("push");
    expect(deriveCategory({ body_part: "upper_legs", force_type: "pull" })).toBe("legs");
    expect(deriveCategory({ body_part: "core" })).toBe("core");
    expect(deriveCategory({ category: "stretching" })).toBe("mobility");
  });

  it("clamps difficulty to the ExperienceLevel enum", () => {
    expect(mapDifficulty("advanced")).toBe("advanced");
    expect(mapDifficulty("expert")).toBe("intermediate");
    expect(mapDifficulty(undefined)).toBe("intermediate");
  });

  it("builds absolute image URLs from repo-relative paths", () => {
    expect(imageUrl("images/flat/pull-up-start.webp")).toBe(
      "https://exercise-dataset.com/images/flat/pull-up-start.webp",
    );
    expect(imageUrl(undefined)).toBeNull();
  });

  it("has a stable normalized name key for matching", () => {
    expect(nameKey("Barbell Bench Press")).toBe("barbell bench press");
    expect(nameKey("Pull-Up")).toBe("pull up");
  });
});

describe("normalize()", () => {
  const twoPose: RepDbExercise = {
    id: "bent-over-db-row",
    name_en: "Bent-Over Dumbbell Row",
    description_en: "  A horizontal pull.  ",
    instructions_en: ["Hinge at the hips", "Row to the ribs", ""],
    tips_en: ["Keep a neutral spine"],
    category: "strength",
    force_type: "pull",
    mechanic: "compound",
    difficulty: "beginner",
    equipment: "dumbbell",
    body_part: "back",
    primary_muscles: ["latissimus_dorsi", "rhomboids"],
    secondary_muscles: ["biceps_brachii", "latissimus_dorsi"],
    goals: ["hypertrophy"],
    met: 5,
    is_unilateral: true,
    is_bodyweight: false,
    images: { flat: { start: "images/flat/bent-over-db-row-start.webp", peak: "images/flat/bent-over-db-row-peak.webp" } },
  };

  it("maps a two-pose strength move end to end", () => {
    const n = normalize(twoPose);
    expect(n.slug).toBe("bent-over-db-row");
    expect(n.equipment).toEqual(["dumbbell"]);
    expect(n.category).toBe("pull");
    expect(n.description).toBe("A horizontal pull.");
    expect(n.instructions).toEqual(["Hinge at the hips", "Row to the ribs"]);
    expect(n.primary).toEqual(["lats", "back"]);
    expect(n.secondary).toEqual(["biceps"]); // deduped against primary
    expect(n.imageStartUrl).toContain("bent-over-db-row-start.webp");
    expect(n.imageEndUrl).toContain("bent-over-db-row-peak.webp");
    expect(n.isUnilateral).toBe(true);
  });

  it("handles single-pose (stretch) records without an end image", () => {
    const n = normalize({
      id: "cat-cow",
      name_en: "Cat-Cow",
      category: "stretching",
      images: { flat: { main: "images/flat/cat-cow-main.webp" } },
    });
    expect(n.imageStartUrl).toContain("cat-cow-main.webp");
    expect(n.imageEndUrl).toBeNull();
    expect(n.category).toBe("mobility");
  });
});
