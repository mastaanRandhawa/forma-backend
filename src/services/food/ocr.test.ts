import { describe, it, expect } from "vitest";
import { parseNutritionLabel, parsedToNormalized, decodeImage } from "./ocr.js";

const US_LABEL = `
Nutrition Facts
Serving size 2/3 cup (55g)
Servings per container About 8
Amount per serving
Calories 230
Total Fat 8g
Saturated Fat 1g
Sodium 160mg
Total Carbohydrate 37g
Dietary Fiber 4g
Total Sugars 12g
Protein 3g
`;

describe("parseNutritionLabel", () => {
  it("pulls the core fields off a US panel", () => {
    const p = parseNutritionLabel(US_LABEL);
    expect(p.servingGrams).toBe(55);
    expect(p.calories).toBe(230);
    expect(p.fat).toBe(8);
    expect(p.carbs).toBe(37);
    expect(p.fiber).toBe(4);
    expect(p.sugar).toBe(12);
    expect(p.protein).toBe(3);
    expect(p.sodiumMg).toBe(160);
    expect(p.per100).toBe(false);
    expect(p.confidence).toBe(1);
  });

  it("recognises a per-100g panel", () => {
    const p = parseNutritionLabel("per 100 g\nEnergy 401 kcal\nProtein 8.1 g\nCarbohydrate 63 g\nFat 12 g");
    expect(p.per100).toBe(true);
    expect(p.calories).toBe(401);
    expect(p.protein).toBe(8.1);
  });

  it("reports partial confidence when fields are missing", () => {
    const p = parseNutritionLabel("Calories 100\nProtein 5g");
    expect(p.confidence).toBe(0.5);
    expect(p.carbs).toBeNull();
  });

  it("handles comma decimals and no OCR noise gracefully", () => {
    const p = parseNutritionLabel("Calories 52\nProtein 0,3 g\nCarbohydrate 14 g\nFat 0,2 g");
    expect(p.protein).toBe(0.3);
    expect(p.fat).toBe(0.2);
  });
});

describe("parsedToNormalized", () => {
  it("scales a per-serving panel to per-100g using the gram weight", () => {
    const p = parseNutritionLabel(US_LABEL);
    const nf = parsedToNormalized(p, { sourceId: "label_1", name: "Cereal" });
    // 230 kcal / 55 g * 100 ≈ 418
    expect(nf.caloriesPer100).toBe(418);
    expect(nf.perServingOnly).toBe(false);
    expect(nf.dataPer).toBe("100g");
    expect(nf.servingGrams).toBe(55);
    expect(nf.source).toBe("custom");
  });

  it("keeps per-serving numbers when no gram weight is on the label", () => {
    const p = parseNutritionLabel("Serving size 1 bar\nCalories 200\nProtein 10g\nCarbohydrate 20g\nFat 8g");
    const nf = parsedToNormalized(p, { sourceId: "label_2", name: "Bar" });
    expect(nf.perServingOnly).toBe(true);
    expect(nf.dataPer).toBe("serving");
    expect(nf.caloriesPer100).toBe(200);
  });

  it("takes a per-100g panel as-is", () => {
    const p = parseNutritionLabel("per 100g\nCalories 400\nProtein 8g\nCarbohydrate 60g\nFat 14g");
    const nf = parsedToNormalized(p, { sourceId: "label_3", name: "Snack" });
    expect(nf.caloriesPer100).toBe(400);
    expect(nf.perServingOnly).toBe(false);
  });
});

describe("decodeImage", () => {
  const px =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  it("decodes a data URL", () => {
    const buf = decodeImage(px);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.length).toBeGreaterThan(0);
  });
  it("rejects non-image input", () => {
    expect(decodeImage("hello world!!")).toBeNull();
    expect(decodeImage("data:text/plain;base64,aGk=")).toBeNull();
  });
});
