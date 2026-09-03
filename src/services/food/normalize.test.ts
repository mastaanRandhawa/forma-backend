import { describe, it, expect } from "vitest";
import {
  normalizeBarcode,
  isPlausibleBarcode,
  normalizeOFF,
  normalizeUSDA,
  normalizeNutritionix,
  normalizeEdamam,
} from "./normalize.js";

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

describe("normalizeNutritionix", () => {
  it("rebases per-serving numbers to per-100g when serving grams known", () => {
    const nf = normalizeNutritionix({
      food_name: "Greek Yogurt",
      brand_name: "Chobani",
      nix_item_id: "abc123",
      upc: "894700010045",
      serving_qty: 1,
      serving_unit: "container",
      serving_weight_grams: 150,
      nf_calories: 120,
      nf_protein: 15,
      nf_total_carbohydrate: 9,
      nf_total_fat: 3,
      nf_sodium: 60,
    });
    expect(nf).toMatchObject({
      source: "nutritionix",
      sourceId: "abc123",
      barcode: "894700010045",
      perServingOnly: false,
      caloriesPer100: 80, // 120 / 150 * 100
      proteinPer100: 10,
    });
    expect(nf!.sodiumPer100).toBe(40);
  });

  it("keeps per-serving basis for a common food with no gram weight", () => {
    const nf = normalizeNutritionix({
      food_name: "apple",
      nf_calories: 95,
      nf_protein: 0.5,
      nf_total_carbohydrate: 25,
      nf_total_fat: 0.3,
    });
    expect(nf).toMatchObject({
      source: "nutritionix",
      sourceId: "common:apple",
      perServingOnly: true,
      dataPer: "serving",
      caloriesPer100: 95,
    });
  });

  it("returns null with no name", () => {
    expect(normalizeNutritionix({ nf_calories: 10 })).toBeNull();
  });
});

describe("normalizeEdamam", () => {
  it("takes parser nutrients as per-100g", () => {
    const nf = normalizeEdamam({
      foodId: "food_abc",
      label: "Brown Rice",
      nutrients: { ENERC_KCAL: 123, PROCNT: 2.7, CHOCDF: 25.6, FAT: 1, FIBTG: 1.6, NA: 4 },
    });
    expect(nf).toMatchObject({
      source: "edamam",
      sourceId: "food_abc",
      dataPer: "100g",
      perServingOnly: false,
      caloriesPer100: 123,
      carbsPer100: 25.6,
      sodiumPer100: 4,
    });
  });

  it("returns null without a foodId or label", () => {
    expect(normalizeEdamam({ label: "x" })).toBeNull();
    expect(normalizeEdamam({ foodId: "y" })).toBeNull();
  });
});
