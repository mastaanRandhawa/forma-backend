import { describe, it, expect } from "vitest";
import {
  resolveGrams,
  computeLogNutrition,
  sumNutrients,
  remaining,
  mealForHour,
  round,
  OZ_TO_G,
} from "./nutrition.js";

const chicken = {
  caloriesPer100: 165,
  proteinPer100: 31,
  carbsPer100: 0,
  fatPer100: 3.6,
  fiberPer100: 0,
  sugarPer100: 0,
  sodimPer100: 74,
  servingGrams: 120,
};

describe("resolveGrams", () => {
  it("grams unit is identity", () => expect(resolveGrams(250, "g")).toBe(250));
  it("oz converts", () => expect(resolveGrams(1, "oz")).toBeCloseTo(OZ_TO_G, 3));
  it("serving uses servingGrams", () => expect(resolveGrams(2, "serving", 120)).toBe(240));
  it("serving without gram weight is unknowable", () => expect(resolveGrams(1, "serving")).toBeNull());
  it("rejects negatives", () => expect(resolveGrams(-1, "g")).toBeNull());
});

describe("computeLogNutrition (per-100 basis)", () => {
  it("100 g → per-100 values", () => {
    const { grams, nutrients } = computeLogNutrition(chicken, 100, "g");
    expect(grams).toBe(100);
    expect(nutrients).toMatchObject({ calories: 165, protein: 31, fat: 3.6 });
  });
  it("250 g scales linearly", () => {
    const { nutrients } = computeLogNutrition(chicken, 250, "g");
    expect(nutrients.calories).toBe(413); // 165*2.5 = 412.5 → 413
    expect(nutrients.protein).toBe(77.5);
  });
  it("1 serving = 120 g", () => {
    const { grams, nutrients } = computeLogNutrition(chicken, 1, "serving");
    expect(grams).toBe(120);
    expect(nutrients.calories).toBe(198);
  });
  it("0.5 serving", () => {
    const { nutrients } = computeLogNutrition(chicken, 0.5, "serving");
    expect(nutrients.calories).toBe(99);
  });
  it("2.5 servings", () => {
    const { nutrients } = computeLogNutrition(chicken, 2.5, "serving");
    expect(nutrients.calories).toBe(495);
  });
  it("1 oz", () => {
    const { nutrients } = computeLogNutrition(chicken, 1, "oz");
    expect(nutrients.calories).toBe(Math.round(165 * (OZ_TO_G / 100)));
  });
});

describe("computeLogNutrition (per-serving-only source)", () => {
  const bar = {
    caloriesPer100: 220,
    proteinPer100: 12,
    carbsPer100: 24,
    fatPer100: 8,
    perServingOnly: true,
    servingGrams: null,
  };
  it("multiplies per-serving values by serving count", () => {
    const { grams, nutrients } = computeLogNutrition(bar, 2, "serving");
    expect(grams).toBeNull();
    expect(nutrients).toMatchObject({ calories: 440, protein: 24 });
  });
  it("gram quantity is not inventable without a per-100 basis", () => {
    const { nutrients } = computeLogNutrition(bar, 50, "g");
    expect(nutrients.calories).toBe(0);
  });
});

describe("sumNutrients", () => {
  it("adds and rounds", () => {
    const total = sumNutrients([
      { calories: 140, protein: 12, carbs: 1, fat: 9 },
      { calories: 310, protein: 8, carbs: 30, fat: 18 },
    ]);
    expect(total).toMatchObject({ calories: 450, protein: 20, carbs: 31, fat: 27 });
  });
});

describe("remaining", () => {
  it("goes negative when over target and is never clamped", () => {
    const r = remaining({ dailyCalories: 2200, proteinGrams: 150 }, { calories: 2310, protein: 118, carbs: 0, fat: 0 });
    expect(r.calories).toBe(-110);
    expect(r.protein).toBe(32);
  });
  it("null goal fields yield null", () => {
    const r = remaining({ dailyCalories: 2000 }, { calories: 500, protein: 10, carbs: 0, fat: 0 });
    expect(r.protein).toBeNull();
  });
});

describe("mealForHour", () => {
  it("maps the day", () => {
    expect(mealForHour(8)).toBe("breakfast");
    expect(mealForHour(12)).toBe("lunch");
    expect(mealForHour(19)).toBe("dinner");
    expect(mealForHour(2)).toBe("snack");
    expect(mealForHour(16)).toBe("snack");
  });
});

describe("round", () => {
  it("kills float fuzz and -0", () => {
    expect(round(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(round(-0), 0)).toBe(true);
  });
});
