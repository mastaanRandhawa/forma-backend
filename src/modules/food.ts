/**
 * Food logging & nutrition tracking.
 *
 *   search / barcode          → external providers via services/food (cached)
 *   custom foods               → user-authored Food rows (source = custom)
 *   diary CRUD                 → FoodLog, nutrition snapshotted server-side
 *   goal                       → NutritionGoal (user-entered targets)
 *   recent / favorites / copy  → conveniences over the user's own history
 *
 * All nutrition on a FoodLog row is computed here from the resolved Food and the
 * quantity — client-submitted calorie/macro numbers are ignored except for
 * quick-add, where there is no food to compute from.
 */
import { Router } from "express";
import { z } from "zod";
import type { Food, MealType } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { foodLimiter } from "../middleware/rateLimit.js";
import {
  searchFoods,
  lookupBarcode,
  resolveFood,
  cacheFood,
  ATTRIBUTION,
  FoodSourceError,
} from "../services/food/index.js";
import {
  computeLogNutrition,
  sumNutrients,
  remaining,
  mealForHour,
  round,
  type Nutrients,
} from "../services/food/nutrition.js";

export const foodRouter = Router();
foodRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

const SOURCES = ["open_food_facts", "usda", "nutritionix", "edamam", "custom"] as const;
type Source = (typeof SOURCES)[number];
const sourceEnum = z.enum(SOURCES);

const MEALS: MealType[] = ["breakfast", "lunch", "dinner", "snack"];
const localDay = (d = new Date()) => {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── attribution / provenance ───────────────────────────────────────────────
foodRouter.get("/attribution", (_req, res) => res.json(ATTRIBUTION));

// ── search (chain: customs → USDA → OFF → Nutritionix → Edamam, first hit) ──
foodRouter.get(
  "/search",
  foodLimiter,
  validate({ query: z.object({ q: z.string().min(1).max(120) }) }),
  asyncHandler(async (req, res) => {
    const { q } = req.query as unknown as { q: string };
    res.json(await searchFoods(q, uid(req)));
  }),
);

// ── barcode lookup (fallback chain: DB → USDA → OFF → Nutritionix → Edamam) ──
//    Optionally accepts a Nutrition-Facts photo (`image`, base64/data-URL) which
//    is used ONLY when every API tier misses — then it is OCR'd and parsed into
//    a custom food the user owns. Same endpoint, image param.
const barcodeQuery = z.object({ code: z.string().min(6).max(20) });
const barcodeImageBody = z.object({ image: z.string().min(32).max(6_000_000).optional() });

async function handleBarcode(code: string, image: string | undefined, userId: string, res: import("express").Response) {
  try {
    const result = await lookupBarcode(code, image ? { image, userId } : {});
    res.json({
      code: result.code,
      status: result.status,
      via: result.via,
      degraded: result.degraded,
      confidence: result.confidence ?? null,
      food: result.food ? withServingOptions(result.food) : null,
    });
  } catch (e) {
    if (e instanceof FoodSourceError) throw badRequest(`${e.source} unavailable — try search or a custom food`);
    throw e;
  }
}

foodRouter.get(
  "/barcode/:code",
  foodLimiter,
  validate({ params: barcodeQuery }),
  asyncHandler(async (req, res) => {
    await handleBarcode(req.params.code, undefined, uid(req), res);
  }),
);

foodRouter.post(
  "/barcode/:code",
  foodLimiter,
  validate({ params: barcodeQuery, body: barcodeImageBody }),
  asyncHandler(async (req, res) => {
    const { image } = req.body as z.infer<typeof barcodeImageBody>;
    await handleBarcode(req.params.code, image, uid(req), res);
  }),
);

// ── resolve one food (serving screen) ──────────────────────────────────────
foodRouter.get(
  "/item/:source/:sourceId",
  validate({ params: z.object({ source: sourceEnum, sourceId: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const { source, sourceId } = req.params as { source: Source; sourceId: string };
    try {
      const food = await resolveFood(source, sourceId, uid(req));
      if (!food) throw notFound("Food not found");
      res.json(withServingOptions(food));
    } catch (e) {
      if (e instanceof FoodSourceError) throw badRequest(`${e.source} unavailable — try search or a custom food`);
      throw e;
    }
  }),
);

// ── custom foods ───────────────────────────────────────────────────────────
const nonNeg = z.number().min(0).max(100_000);
const customBody = z.object({
  name: z.string().min(1).max(120),
  brand: z.string().max(120).optional(),
  servingSize: z.number().positive().max(100_000),
  servingUnit: z.string().min(1).max(24),
  servingGrams: z.number().positive().max(100_000).optional(),
  basis: z.enum(["serving", "100g"]).default("serving"),
  calories: nonNeg,
  protein: nonNeg.optional(),
  carbs: nonNeg.optional(),
  fat: nonNeg.optional(),
  fiber: nonNeg.optional(),
  sugar: nonNeg.optional(),
  sodium: nonNeg.optional(), // mg
});

foodRouter.get(
  "/custom",
  asyncHandler(async (req, res) => {
    res.json(
      (await prisma.food.findMany({ where: { source: "custom", ownerId: uid(req) }, orderBy: { createdAt: "desc" } }))
        .map(withServingOptions),
    );
  }),
);

foodRouter.post(
  "/custom",
  validate({ body: customBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof customBody>;
    const per100 = (v: number | undefined): number | null | undefined => {
      if (v == null) return v;
      if (b.basis === "100g") return v;
      // per-serving → per-100g needs a gram weight
      const grams = b.servingGrams ?? (b.servingUnit === "g" ? b.servingSize : null);
      return grams && grams > 0 ? round((v / grams) * 100, 2) : null;
    };
    const perServingFallback = !((b.servingGrams ?? 0) > 0) && b.servingUnit !== "g" && b.basis === "serving";

    const sourceId = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const food = await prisma.food.create({
      data: {
        source: "custom",
        sourceId,
        ownerId: uid(req),
        name: b.name,
        brand: b.brand ?? null,
        servingSize: b.servingSize,
        servingUnit: b.servingUnit,
        servingGrams: b.servingGrams ?? (b.servingUnit === "g" ? b.servingSize : null),
        caloriesPer100: perServingFallback ? b.calories : per100(b.calories) ?? b.calories,
        proteinPer100: perServingFallback ? b.protein ?? 0 : per100(b.protein) ?? b.protein ?? 0,
        carbsPer100: perServingFallback ? b.carbs ?? 0 : per100(b.carbs) ?? b.carbs ?? 0,
        fatPer100: perServingFallback ? b.fat ?? 0 : per100(b.fat) ?? b.fat ?? 0,
        fiberPer100: perServingFallback ? b.fiber ?? null : per100(b.fiber) ?? null,
        sugarPer100: perServingFallback ? b.sugar ?? null : per100(b.sugar) ?? null,
        sodiumPer100: perServingFallback ? b.sodium ?? null : per100(b.sodium) ?? null,
        perServingOnly: perServingFallback,
        dataPer: perServingFallback ? "serving" : "100g",
      },
    });
    res.status(201).json(withServingOptions(food));
  }),
);

foodRouter.delete(
  "/custom/:sourceId",
  asyncHandler(async (req, res) => {
    await prisma.food.deleteMany({ where: { source: "custom", ownerId: uid(req), sourceId: req.params.sourceId } });
    res.status(204).end();
  }),
);

// ── nutrition goal ─────────────────────────────────────────────────────────
foodRouter.get(
  "/goal",
  asyncHandler(async (req, res) => {
    res.json(await prisma.nutritionGoal.findUnique({ where: { userId: uid(req) } }));
  }),
);

foodRouter.put(
  "/goal",
  validate({
    body: z.object({
      dailyCalories: z.number().int().min(0).max(20_000).nullish(),
      proteinGrams: z.number().min(0).max(2000).nullish(),
      carbGrams: z.number().min(0).max(2000).nullish(),
      fatGrams: z.number().min(0).max(2000).nullish(),
      fiberGrams: z.number().min(0).max(500).nullish(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const b = req.body as Record<string, number | null>;
    const row = await prisma.nutritionGoal.upsert({
      where: { userId },
      create: { userId, ...b },
      update: b,
    });
    res.json(row);
  }),
);

// ── diary ──────────────────────────────────────────────────────────────────
async function dayView(userId: string, date: string) {
  const [logs, goal] = await Promise.all([
    prisma.foodLog.findMany({ where: { userId, date }, orderBy: { loggedAt: "asc" } }),
    prisma.nutritionGoal.findUnique({ where: { userId } }),
  ]);
  const meals = Object.fromEntries(MEALS.map((m) => [m, logs.filter((l) => l.mealType === m)])) as Record<
    MealType,
    typeof logs
  >;
  const totals = sumNutrients(logs.map(nutrientsOf));
  const mealTotals = Object.fromEntries(
    MEALS.map((m) => [m, sumNutrients(meals[m].map(nutrientsOf))]),
  ) as Record<MealType, Nutrients>;
  return {
    date,
    goal: goal ?? null,
    meals,
    mealTotals,
    totals,
    remaining: goal ? remaining(goal, totals) : null,
  };
}

const nutrientsOf = (l: {
  calories: number; protein: number; carbs: number; fat: number;
  fiber: number | null; sugar: number | null; sodium: number | null;
}): Nutrients => ({
  calories: l.calories, protein: l.protein, carbs: l.carbs, fat: l.fat,
  fiber: l.fiber, sugar: l.sugar, sodium: l.sodium,
});

foodRouter.get(
  "/log",
  validate({ query: z.object({ date: z.string().regex(DATE_RE).optional() }) }),
  asyncHandler(async (req, res) => {
    const date = (req.query as { date?: string }).date ?? localDay();
    res.json(await dayView(uid(req), date));
  }),
);

const logBody = z.object({
  // referenced food
  source: sourceEnum.optional(),
  sourceId: z.string().min(1).optional(),
  // quick-add (no food)
  quickAdd: z
    .object({
      name: z.string().max(80).optional(),
      calories: z.number().min(0).max(20_000),
      protein: z.number().min(0).max(2000).optional(),
      carbs: z.number().min(0).max(2000).optional(),
      fat: z.number().min(0).max(2000).optional(),
    })
    .optional(),
  mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
  quantity: z.number().positive().max(10_000).default(1),
  servingUnit: z.enum(["serving", "g", "oz"]).default("serving"),
  date: z.string().regex(DATE_RE).optional(),
  loggedAt: z.coerce.date().optional(),
});

foodRouter.post(
  "/log",
  validate({ body: logBody }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const b = req.body as z.infer<typeof logBody>;
    const loggedAt = b.loggedAt ?? new Date();
    const date = b.date ?? localDay(loggedAt);
    const mealType = b.mealType ?? mealForHour(loggedAt.getHours());

    let row;
    if (b.quickAdd) {
      row = await prisma.foodLog.create({
        data: {
          userId, mealType, date, loggedAt,
          foodName: b.quickAdd.name?.trim() || "Quick add",
          quantity: 1, servingUnit: "serving",
          calories: Math.round(b.quickAdd.calories),
          protein: round(b.quickAdd.protein ?? 0),
          carbs: round(b.quickAdd.carbs ?? 0),
          fat: round(b.quickAdd.fat ?? 0),
        },
      });
    } else {
      if (!b.source || !b.sourceId) throw badRequest("source + sourceId or quickAdd required");
      const food = await resolveOrThrow(b.source, b.sourceId, userId);
      const { grams, nutrients } = computeLogNutrition(food, b.quantity, b.servingUnit);
      row = await prisma.foodLog.create({
        data: {
          userId, mealType, date, loggedAt,
          foodId: food.id, source: food.source, sourceId: food.sourceId,
          foodName: food.name, brand: food.brand,
          quantity: b.quantity, servingUnit: b.servingUnit, grams,
          ...nutrients,
        },
      });
    }
    const day = await dayView(userId, date);
    res.status(201).json({ entry: row, day });
    // auto-connect: set protein goal progress to today's total protein
    void syncProteinGoal(userId, day.totals.protein).catch(() => {});
  }),
);

foodRouter.patch(
  "/log/:id",
  validate({
    body: z.object({
      quantity: z.number().positive().max(10_000).optional(),
      servingUnit: z.enum(["serving", "g", "oz"]).optional(),
      mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
      date: z.string().regex(DATE_RE).optional(),
      loggedAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const existing = await prisma.foodLog.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw notFound("Entry not found");
    const b = req.body as {
      quantity?: number; servingUnit?: "serving" | "g" | "oz"; mealType?: MealType; date?: string; loggedAt?: Date;
    };

    const quantity = b.quantity ?? existing.quantity;
    const servingUnit = b.servingUnit ?? existing.servingUnit;
    let recomputed: Record<string, number | null> = {};
    if ((b.quantity != null || b.servingUnit != null) && existing.foodId) {
      const food = await prisma.food.findUnique({ where: { id: existing.foodId } });
      if (food) {
        const { grams, nutrients } = computeLogNutrition(food, quantity, servingUnit);
        recomputed = { grams, ...nutrients };
      }
    }
    const loggedAt = b.loggedAt ?? existing.loggedAt;
    const row = await prisma.foodLog.update({
      where: { id: existing.id },
      data: {
        quantity, servingUnit,
        mealType: b.mealType ?? existing.mealType,
        loggedAt,
        date: b.date ?? (b.loggedAt ? localDay(loggedAt) : existing.date),
        ...recomputed,
      },
    });
    res.json({ entry: row, day: await dayView(userId, row.date) });
  }),
);

foodRouter.delete(
  "/log/:id",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const row = await prisma.foodLog.findFirst({ where: { id: req.params.id, userId } });
    if (!row) return res.status(204).end();
    await prisma.foodLog.delete({ where: { id: row.id } });
    res.json({ ok: true, day: await dayView(userId, row.date) });
  }),
);

// ── recent foods (from the user's own history — no external call) ───────────
foodRouter.get(
  "/recent",
  validate({ query: z.object({ limit: z.coerce.number().min(1).max(50).default(20) }) }),
  asyncHandler(async (req, res) => {
    const limit = Number((req.query as unknown as { limit: number }).limit);
    const logs = await prisma.foodLog.findMany({
      where: { userId: uid(req), source: { not: null } },
      orderBy: { loggedAt: "desc" },
      take: 200,
    });
    const seen = new Set<string>();
    const recent = [];
    for (const l of logs) {
      const key = `${l.source}:${l.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recent.push({
        source: l.source, sourceId: l.sourceId, foodName: l.foodName, brand: l.brand,
        lastQuantity: l.quantity, lastServingUnit: l.servingUnit, lastMealType: l.mealType,
        calories: l.calories, protein: l.protein, lastLoggedAt: l.loggedAt,
      });
      if (recent.length >= limit) break;
    }
    res.json(recent);
  }),
);

// ── favorites ──────────────────────────────────────────────────────────────
foodRouter.get(
  "/favorites",
  asyncHandler(async (req, res) => {
    res.json(await prisma.favoriteFood.findMany({ where: { userId: uid(req) }, orderBy: { createdAt: "desc" } }));
  }),
);

foodRouter.post(
  "/favorites",
  validate({
    body: z.object({ source: sourceEnum, sourceId: z.string().min(1) }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { source, sourceId } = req.body as { source: Source; sourceId: string };
    const food = await resolveOrThrow(source, sourceId, userId);
    const fav = await prisma.favoriteFood.upsert({
      where: { userId_source_sourceId: { userId, source, sourceId } },
      create: { userId, source, sourceId, foodId: food.id, foodName: food.name, brand: food.brand },
      update: {},
    });
    res.status(201).json(fav);
  }),
);

foodRouter.delete(
  "/favorites/:id",
  asyncHandler(async (req, res) => {
    await prisma.favoriteFood.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
    res.status(204).end();
  }),
);

// ── copy a meal / day ──────────────────────────────────────────────────────
foodRouter.post(
  "/copy",
  validate({
    body: z.object({
      fromDate: z.string().regex(DATE_RE),
      toDate: z.string().regex(DATE_RE),
      meal: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
      toMeal: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { fromDate, toDate, meal, toMeal } = req.body as {
      fromDate: string; toDate: string; meal?: MealType; toMeal?: MealType;
    };
    const src = await prisma.foodLog.findMany({
      where: { userId, date: fromDate, ...(meal ? { mealType: meal } : {}) },
    });
    if (src.length === 0) throw badRequest("Nothing to copy from that day");
    const at = new Date(`${toDate}T12:00:00`);
    await prisma.foodLog.createMany({
      data: src.map((l) => ({
        userId, date: toDate, loggedAt: at,
        mealType: toMeal ?? l.mealType,
        foodId: l.foodId, source: l.source, sourceId: l.sourceId, foodName: l.foodName, brand: l.brand,
        quantity: l.quantity, servingUnit: l.servingUnit, grams: l.grams,
        calories: l.calories, protein: l.protein, carbs: l.carbs, fat: l.fat,
        fiber: l.fiber, sugar: l.sugar, sodium: l.sodium,
      })),
    });
    res.status(201).json({ copied: src.length, day: await dayView(userId, toDate) });
  }),
);

// ── daily totals trend ─────────────────────────────────────────────────────
foodRouter.get(
  "/summary",
  validate({ query: z.object({ days: z.coerce.number().min(1).max(90).default(14) }) }),
  asyncHandler(async (req, res) => {
    const days = Number((req.query as unknown as { days: number }).days);
    const since = localDay(new Date(Date.now() - days * 86_400_000));
    const logs = await prisma.foodLog.findMany({ where: { userId: uid(req), date: { gte: since } } });
    const byDay = new Map<string, Nutrients[]>();
    for (const l of logs) byDay.set(l.date, [...(byDay.get(l.date) ?? []), nutrientsOf(l)]);
    res.json({
      days: [...byDay.entries()]
        .map(([date, list]) => ({ date, ...sumNutrients(list) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  }),
);

// ── helpers ────────────────────────────────────────────────────────────────
async function resolveOrThrow(source: Source, sourceId: string, userId: string) {
  try {
    const food = await resolveFood(source, sourceId, userId);
    if (food) return food;
  } catch (e) {
    if (!(e instanceof FoodSourceError)) throw e;
  }
  throw badRequest("Could not resolve that food — it may no longer be available");
}

/** Attach the serving-size choices the UI offers for a food. */
function withServingOptions(food: Food) {
  const options: { unit: string; label: string; grams: number | null }[] = [];
  if (food.servingGrams && food.servingGrams > 0) {
    options.push({
      unit: "serving",
      label: `1 serving (${food.servingGrams} g)`,
      grams: food.servingGrams,
    });
  } else if (food.perServingOnly) {
    options.push({ unit: "serving", label: `1 ${food.servingUnit ?? "serving"}`, grams: null });
  }
  options.push({ unit: "g", label: "grams", grams: 1 });
  options.push({ unit: "oz", label: "ounces", grams: 28.35 });
  return { ...food, servingOptions: options };
}

// re-export for warm-cache use elsewhere if needed
export { cacheFood };

/** Auto-connect: set the user's protein goal progress to today's actual total. */
async function syncProteinGoal(userId: string, totalProteinG: number): Promise<void> {
  const goal = await prisma.goal.findFirst({ where: { userId, key: "protein", active: true } });
  if (!goal) return;
  const periodKey = new Date().toISOString().slice(0, 10);
  const value = Math.round(totalProteinG);
  await prisma.goalEntry.upsert({
    where: { goalId_periodKey: { goalId: goal.id, periodKey } },
    update: { value, completed: value >= goal.target },
    create: { goalId: goal.id, periodKey, value, completed: value >= goal.target },
  });
}
