import { describe, it, expect } from "vitest";
import { normalizeBarcode, isPlausibleBarcode, normalizeOFF, normalizeUSDA } from "./normalize.js";

describe("normalizeBarcode", () => {
  it("strips non-digits", () => expect(normalizeBarcode("0 12345 67890 5")).toBe("0012345678905"));
  it("UPC-A (12) → EAN-13", () => expect(normalizeBarcode("012345678905")).toBe("0012345678905"));
  it("EAN-13 unchanged", () => expect(normalizeBarcode("4006381333931")).toBe("4006381333931"));
  it("plausibility gate", () => {
    expect(isPlausibleBarcode("40063813")).toBe(true);
    expect(isPlausibleBarcode("123")).toBe(false);
  });
});

describe("normalizeOFF", () => {
  it("per-100g product", () => {
    const nf = normalizeOFF({
      code: "4006381333931",
      product_name: "Test Cola",
      brands: "TestCo, Other",
      serving_size: "330 ml",
      serving_quantity: 330,
      nutrition_data_per: "100g",
      nutriments: {
        "energy-kcal_100g": 42,
        proteins_100g: 0,
        carbohydrates_100g: 10.6,
        fat_100g: 0,
        sugars_100g: 10.6,
        salt_100g: 0.01,
      },
    });
    expect(nf).toMatchObject({
      source: "open_food_facts",
      sourceId: "4006381333931",
      name: "Test Cola",
      brand: "TestCo",
      caloriesPer100: 42,
      carbsPer100: 10.6,
      perServingOnly: false,
      servingGrams: 330,
    });
    expect(nf!.sodiumPer100).toBeCloseTo((0.01 / 2.5) * 1000, 0);
  });

  it("derives kcal from kJ when kcal missing", () => {
    const nf = normalizeOFF({
      code: "1",
      product_name: "X",
      nutrition_data_per: "100g",
      nutriments: { energy_100g: 418.4, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 },
    });
    expect(nf!.caloriesPer100).toBe(100);
  });

  it("returns null with no name or no nutrients", () => {
    expect(normalizeOFF({ code: "1", nutriments: {} })).toBeNull();
    expect(normalizeOFF({ code: "1", product_name: "Y", nutriments: {} })).toBeNull();
  });
});

describe("normalizeUSDA", () => {
  it("Foundation food maps per-100g by nutrient number", () => {
    const nf = normalizeUSDA({
      fdcId: 171077,
      description: "Chicken breast, roasted",
      dataType: "SR Legacy",
      foodNutrients: [
        { nutrientNumber: "208", value: 165 },
        { nutrientNumber: "203", value: 31 },
        { nutrientNumber: "205", value: 0 },
        { nutrientNumber: "204", value: 3.57 },
        { nutrientNumber: "291", value: 0 },
        { nutrientNumber: "307", value: 74 },
      ],
    });
    expect(nf).toMatchObject({
      source: "usda",
      sourceId: "171077",
      caloriesPer100: 165,
      proteinPer100: 31,
      fatPer100: 3.6,
      sodiumPer100: 74,
      perServingOnly: false,
    });
  });

  it("Branded food with label panel uses per-serving basis", () => {
    const nf = normalizeUSDA({
      fdcId: 999,
      description: "Protein Bar",
      brandName: "BrandX",
      dataType: "Branded",
      servingSize: 60,
      servingSizeUnit: "g",
      labelNutrients: {
        calories: { value: 220 },
        protein: { value: 20 },
        carbohydrates: { value: 22 },
        fat: { value: 7 },
      },
    });
    expect(nf).toMatchObject({ perServingOnly: true, dataPer: "serving", servingGrams: 60, brand: "BrandX" });
  });
});
