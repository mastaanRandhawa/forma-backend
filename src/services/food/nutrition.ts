/**
 * nutrition — pure calculation for the food logger.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested and reused on the client. No gram conversions are invented: if a food
 * has no `servingGrams`, a "serving" quantity can still be logged but `grams`
 * comes back null and per-100 scaling falls back to the per-serving basis.
 */

export interface Nutrients {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number | null;
  sugar?: number | null;
  sodium?: number | null; // milligrams
}

export const OZ_TO_G = 28.349523125;

/** Round to `dp` decimals, killing -0 and float fuzz. */
export function round(n: number, dp = 1): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f || 0;
}

const roundAll = (n: Nutrients): Nutrients => ({
  calories: Math.round(n.calories) || 0,
  protein: round(n.protein),
  carbs: round(n.carbs),
  fat: round(n.fat),
  fiber: n.fiber == null ? null : round(n.fiber),
  sugar: n.sugar == null ? null : round(n.sugar),
  sodium: n.sodium == null ? null : Math.round(n.sodium) || 0,
});

export interface FoodBasis {
  caloriesPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  fiberPer100?: number | null;
  sugarPer100?: number | null;
  sodiumPer100?: number | null;
  servingGrams?: number | null;
  /** true ⇒ the *Per100 fields actually hold per-serving values */
  perServingOnly?: boolean;
}

/**
 * Grams represented by a log line. `null` when it genuinely can't be known
 * (a "serving" quantity of a food with no gram weight).
 */
export function resolveGrams(
  quantity: number,
  servingUnit: string,
  servingGrams?: number | null,
): number | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  if (servingUnit === "g") return round(quantity, 2);
  if (servingUnit === "oz") return round(quantity * OZ_TO_G, 2);
  // "serving"
  if (servingGrams && servingGrams > 0) return round(quantity * servingGrams, 2);
  return null;
}

/**
 * Nutrition for a log line. Prefers per-100 × grams; when grams are unknown and
 * the source is per-serving, multiplies the per-serving values by the serving
 * count instead.
 */
export function computeLogNutrition(
  food: FoodBasis,
  quantity: number,
  servingUnit: string,
): { grams: number | null; nutrients: Nutrients } {
  const grams = resolveGrams(quantity, servingUnit, food.servingGrams);

  const per100 = (v: number | null | undefined): number | null => {
    if (v == null) return null;
    // perServingOnly ⇒ the *Per100 fields actually hold per-serving values, so a
    // gram/oz quantity can't be derived without inventing a conversion.
    if (food.perServingOnly) return servingUnit === "serving" ? v * quantity : null;
    if (grams != null) return (v * grams) / 100;
    return null;
  };

  const nutrients = roundAll({
    calories: per100(food.caloriesPer100) ?? 0,
    protein: per100(food.proteinPer100) ?? 0,
    carbs: per100(food.carbsPer100) ?? 0,
    fat: per100(food.fatPer100) ?? 0,
    fiber: per100(food.fiberPer100),
    sugar: per100(food.sugarPer100),
    sodium: per100(food.sodiumPer100),
  });
  return { grams, nutrients };
}

export function sumNutrients(list: Nutrients[]): Nutrients {
  return roundAll(
    list.reduce<Nutrients>(
      (t, n) => ({
        calories: t.calories + (n.calories || 0),
        protein: t.protein + (n.protein || 0),
        carbs: t.carbs + (n.carbs || 0),
        fat: t.fat + (n.fat || 0),
        fiber: (t.fiber ?? 0) + (n.fiber ?? 0),
        sugar: (t.sugar ?? 0) + (n.sugar ?? 0),
        sodium: (t.sodium ?? 0) + (n.sodium ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 },
    ),
  );
}

export interface Goal {
  dailyCalories?: number | null;
  proteinGrams?: number | null;
  carbGrams?: number | null;
  fatGrams?: number | null;
  fiberGrams?: number | null;
}

/** Remaining = goal − consumed. May be negative (over target) — never clamped. */
export function remaining(goal: Goal, consumed: Nutrients) {
  const diff = (g: number | null | undefined, c: number) => (g == null ? null : round(g - c));
  return {
    calories: goal.dailyCalories == null ? null : Math.round(goal.dailyCalories - consumed.calories),
    protein: diff(goal.proteinGrams, consumed.protein),
    carbs: diff(goal.carbGrams, consumed.carbs),
    fat: diff(goal.fatGrams, consumed.fat),
    fiber: diff(goal.fiberGrams, consumed.fiber ?? 0),
  };
}

/** Sensible default meal for a local hour (0–23). User can always override. */
export function mealForHour(hour: number): "breakfast" | "lunch" | "dinner" | "snack" {
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 17 && hour < 22) return "dinner";
  return "snack";
}
