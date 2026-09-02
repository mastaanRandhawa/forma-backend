/**
 * normalize — map Open Food Facts and USDA FoodData Central payloads onto one
 * internal food model. Pure; unit tested in normalize.test.ts.
 *
 * The unified shape stores nutrition per 100 g/ml when the source provides a
 * per-100 basis, and per-serving otherwise (`perServingOnly`). Additional
 * micronutrients are carried in `micros` so the model can grow without a
 * redesign.
 */

export type FoodSource = "open_food_facts" | "usda" | "nutritionix" | "edamam" | "custom";

export interface NormalizedFood {
  source: FoodSource;
  sourceId: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  servingSize: number | null;
  servingUnit: string | null;
  servingGrams: number | null;
  caloriesPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  fiberPer100: number | null;
  sugarPer100: number | null;
  sodiumPer100: number | null; // mg
  micros: Record<string, { amount: number; unit: string }> | null;
  perServingOnly: boolean;
  dataPer: "100g" | "100ml" | "serving";
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Digits only. UPC-A (12) → EAN-13 by left-padding a zero, which is how Open
 * Food Facts stores them. UPC-E is left as-is (its 6/8-digit form is expanded by
 * scanners, not here) — inventing an expansion risks a wrong lookup.
 */
export function normalizeBarcode(raw: string): string {
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 12) return `0${d}`;
  return d;
}

export function isPlausibleBarcode(code: string): boolean {
  return /^\d{8}$|^\d{12,14}$/.test(code);
}

// ── Open Food Facts ─────────────────────────────────────────────────────────

interface OFFProduct {
  code?: string;
  product_name?: string;
  generic_name?: string;
  brands?: string;
  quantity?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  image_front_url?: string;
  image_url?: string;
  nutriments?: Record<string, number | string | undefined>;
  nutrition_data_per?: string;
}

export function normalizeOFF(p: OFFProduct): NormalizedFood | null {
  const n = p.nutriments ?? {};
  const name = (p.product_name || p.generic_name || "").trim();
  if (!name) return null;

  const per = p.nutrition_data_per === "serving" ? "serving" : "100g";
  const suffix = per === "serving" ? "_serving" : "_100g";
  const g = (key: string) => num(n[`${key}${suffix}`]) ?? num(n[`${key}_100g`]) ?? num(n[key]);

  let kcal = g("energy-kcal");
  if (kcal == null) {
    const kj = g("energy-kj") ?? g("energy");
    if (kj != null) kcal = kj / 4.184;
  }
  const protein = g("proteins");
  const carbs = g("carbohydrates");
  const fat = g("fat");
  if (kcal == null && protein == null && carbs == null && fat == null) return null;

  // sodium: prefer sodium (g → mg); else derive from salt (g) ÷ 2.5
  let sodiumMg: number | null = null;
  const sodium = g("sodium");
  const salt = g("salt");
  if (sodium != null) sodiumMg = sodium * 1000;
  else if (salt != null) sodiumMg = (salt / 2.5) * 1000;

  const servingGrams = num(p.serving_quantity);

  return {
    source: "open_food_facts",
    sourceId: (p.code ?? "").trim(),
    barcode: (p.code ?? "").trim() || null,
    name,
    brand: (p.brands ?? "").split(",")[0]?.trim() || null,
    imageUrl: p.image_front_url || p.image_url || null,
    servingSize: servingGrams,
    servingUnit: p.serving_size ? "serving" : servingGrams ? "g" : null,
    servingGrams,
    caloriesPer100: round0(kcal ?? 0),
    proteinPer100: round1(protein ?? 0),
    carbsPer100: round1(carbs ?? 0),
    fatPer100: round1(fat ?? 0),
    fiberPer100: nn(g("fiber")),
    sugarPer100: nn(g("sugars")),
    sodiumPer100: sodiumMg == null ? null : round0(sodiumMg),
    micros: null,
    perServingOnly: per === "serving",
    dataPer: per === "serving" ? "serving" : "100g",
  };
}

// ── USDA FoodData Central ───────────────────────────────────────────────────

interface USDANutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  number?: string;
  value?: number;
  amount?: number;
  nutrientName?: string;
  nutrient?: { number?: string; name?: string; unitName?: string };
  unitName?: string;
}

interface USDAFood {
  fdcId: number;
  description?: string;
  brandName?: string;
  brandOwner?: string;
  dataType?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodNutrients?: USDANutrient[];
  labelNutrients?: Record<string, { value?: number }>;
}

// USDA nutrient numbers
const N = { kcal: "208", protein: "203", fat: "204", carbs: "205", fiber: "291", sugar: "269", sodium: "307" };

function usdaNutrientMap(list: USDANutrient[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of list) {
    const number = String(item.nutrientNumber ?? item.number ?? item.nutrient?.number ?? "");
    const value = item.value ?? item.amount;
    if (number && typeof value === "number" && !(number in out)) out[number] = value;
  }
  return out;
}

export function normalizeUSDA(f: USDAFood): NormalizedFood {
  const name = (f.description ?? "").trim() || `USDA food ${f.fdcId}`;
  const brand = (f.brandName || f.brandOwner || "").trim() || null;

  // Branded foods with a label panel → per-serving basis.
  const label = f.labelNutrients;
  const hasLabel =
    !!label && [label.calories, label.protein, label.carbohydrates, label.fat].some((x) => x?.value != null);

  if (hasLabel && f.servingSize && f.servingSizeUnit) {
    const lv = (k: keyof NonNullable<typeof label>) => nn(label![k]?.value);
    const gramsPerServing =
      f.servingSizeUnit.toLowerCase() === "g" || f.servingSizeUnit.toLowerCase() === "ml"
        ? f.servingSize
        : null;
    return {
      source: "usda",
      sourceId: String(f.fdcId),
      barcode: null,
      name,
      brand,
      imageUrl: null,
      servingSize: f.servingSize,
      servingUnit: gramsPerServing ? "g" : "serving",
      servingGrams: gramsPerServing,
      caloriesPer100: round0(lv("calories") ?? 0),
      proteinPer100: round1(lv("protein") ?? 0),
      carbsPer100: round1(lv("carbohydrates") ?? 0),
      fatPer100: round1(lv("fat") ?? 0),
      fiberPer100: lv("fiber"),
      sugarPer100: lv("sugars"),
      sodiumPer100: lv("sodium"),
      micros: null,
      perServingOnly: true,
      dataPer: "serving",
    };
  }

  // Foundation / SR Legacy / Survey → per 100 g.
  const m = usdaNutrientMap(f.foodNutrients ?? []);
  const gramsPerServing =
    f.servingSize && (f.servingSizeUnit ?? "").toLowerCase() === "g" ? f.servingSize : null;
  return {
    source: "usda",
    sourceId: String(f.fdcId),
    barcode: null,
    name,
    brand,
    imageUrl: null,
    servingSize: f.servingSize ?? null,
    servingUnit: gramsPerServing ? "g" : f.householdServingFullText ? "serving" : null,
    servingGrams: gramsPerServing,
    caloriesPer100: round0(m[N.kcal] ?? 0),
    proteinPer100: round1(m[N.protein] ?? 0),
    carbsPer100: round1(m[N.carbs] ?? 0),
    fatPer100: round1(m[N.fat] ?? 0),
    fiberPer100: nn(m[N.fiber]),
    sugarPer100: nn(m[N.sugar]),
    sodiumPer100: nn(m[N.sodium]),
    micros: null,
    perServingOnly: false,
    dataPer: "100g",
  };
}

const nn = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v);
const round0 = (n: number) => Math.round(n) || 0;
const round1 = (n: number) => Math.round(n * 10) / 10 || 0;

// ── Nutritionix ─────────────────────────────────────────────────────────────

interface NutritionixLike {
  food_name?: string;
  brand_name?: string;
  nix_brand_name?: string;
  nix_item_id?: string;
  upc?: string;
  serving_qty?: number;
  serving_unit?: string;
  serving_weight_grams?: number;
  nf_calories?: number;
  nf_protein?: number;
  nf_total_carbohydrate?: number;
  nf_total_fat?: number;
  nf_dietary_fiber?: number;
  nf_sugars?: number;
  nf_sodium?: number;
  photo?: { thumb?: string };
}

/**
 * Nutritionix numbers are per serving. With `serving_weight_grams` we rebase to
 * per-100 g; otherwise we keep the per-serving figures and set `perServingOnly`.
 * `sourceId`: branded → `nix_item_id`; common/generic → `common:<food_name>`.
 */
export function normalizeNutritionix(f: NutritionixLike): NormalizedFood | null {
  const name = (f.food_name ?? "").trim();
  if (!name) return null;
  const grams = num(f.serving_weight_grams);
  const scale = grams && grams > 0 ? 100 / grams : 1;
  const perServingOnly = !(grams && grams > 0);
  const v = (x: unknown): number => {
    const raw = num(x);
    return raw == null ? 0 : round1(raw * scale);
  };
  const sodium = num(f.nf_sodium);
  return {
    source: "nutritionix",
    sourceId: f.nix_item_id?.trim() || `${NIX_COMMON_PREFIX}${name.toLowerCase()}`,
    barcode: (f.upc ?? "").trim() || null,
    name,
    brand: (f.brand_name || f.nix_brand_name || "").trim() || null,
    imageUrl: f.photo?.thumb || null,
    servingSize: grams ?? num(f.serving_qty),
    servingUnit: grams ? "g" : f.serving_unit?.trim() || null,
    servingGrams: grams,
    caloriesPer100: round0(v(f.nf_calories)),
    proteinPer100: v(f.nf_protein),
    carbsPer100: v(f.nf_total_carbohydrate),
    fatPer100: v(f.nf_total_fat),
    fiberPer100: f.nf_dietary_fiber == null ? null : v(f.nf_dietary_fiber),
    sugarPer100: f.nf_sugars == null ? null : v(f.nf_sugars),
    sodiumPer100: sodium == null ? null : round0(sodium * scale),
    micros: null,
    perServingOnly,
    dataPer: perServingOnly ? "serving" : "100g",
  };
}

const NIX_COMMON_PREFIX = "common:";

// ── Edamam ─────────────────────────────────────────────────────────────────

interface EdamamLike {
  foodId?: string;
  label?: string;
  brand?: string;
  image?: string;
  nutrients?: {
    ENERC_KCAL?: number;
    PROCNT?: number;
    FAT?: number;
    CHOCDF?: number;
    FIBTG?: number;
    SUGAR?: number;
    NA?: number;
  };
}

/** Edamam parser `nutrients` are already per 100 g. */
export function normalizeEdamam(f: EdamamLike): NormalizedFood | null {
  const name = (f.label ?? "").trim();
  if (!name || !f.foodId) return null;
  const nut = f.nutrients ?? {};
  const na = num(nut.NA);
  return {
    source: "edamam",
    sourceId: f.foodId,
    barcode: null,
    name,
    brand: (f.brand ?? "").trim() || null,
    imageUrl: f.image || null,
    servingSize: null,
    servingUnit: null,
    servingGrams: null,
    caloriesPer100: round0(num(nut.ENERC_KCAL) ?? 0),
    proteinPer100: round1(num(nut.PROCNT) ?? 0),
    carbsPer100: round1(num(nut.CHOCDF) ?? 0),
    fatPer100: round1(num(nut.FAT) ?? 0),
    fiberPer100: nn(num(nut.FIBTG)),
    sugarPer100: nn(num(nut.SUGAR)),
    sodiumPer100: na == null ? null : round0(na),
    micros: null,
    perServingOnly: false,
    dataPer: "100g",
  };
}
