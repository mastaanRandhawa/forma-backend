/**
 * Food provider — the single abstraction the API layer talks to.
 *
 * Fallback chain (stop at the first hit; backfill the `Food` cache with it):
 *
 *          UPC SCAN                          TEXT SEARCH
 *             │                                  │
 *   1. your Food database  ◄───────────────►  Food cache + user customs + search cache
 *             │ miss                             │ miss
 *   2. USDA FoodData Central (branded/UPC)   USDA FoodData Central (search)
 *             │ miss                             │ miss
 *   3. Open Food Facts (product)             Open Food Facts (search)
 *             │ miss                             │ miss
 *   4. Nutritionix (?upc=)                   Nutritionix (instant)
 *             │ miss                             │ miss
 *   5. Edamam (?upc=)   [dark w/o keys]      Edamam (parser)   [dark w/o keys]
 *             │ miss
 *   6. user photographs label → OCR / nutrition parser  (barcode path only)
 *
 * Every non-DB hit is written back via `cacheFood`, so the next identical lookup
 * short-circuits at step 1. The user's `FoodLog` rows are permanent and
 * independent of all of this.
 */
import type { Food } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { env } from "../../env.js";
import {
  normalizeOFF,
  normalizeUSDA,
  normalizeNutritionix,
  normalizeEdamam,
  normalizeBarcode,
  isPlausibleBarcode,
  type NormalizedFood,
  type FoodSource,
} from "./normalize.js";
import { offLookupBarcode, offSearch, OFF_ATTRIBUTION, FoodSourceError } from "./openFoodFacts.js";
import {
  usdaSearch,
  usdaGetFood,
  usdaLookupUpc,
  usdaConfigured,
  USDA_ATTRIBUTION,
} from "./usda.js";
import {
  nutritionixSearch,
  nutritionixLookupUpc,
  nutritionixGetItem,
  nutritionixNaturalNutrients,
  nutritionixConfigured,
  NIX_COMMON_PREFIX,
  NUTRITIONIX_ATTRIBUTION,
} from "./nutritionix.js";
import {
  edamamSearch,
  edamamLookupUpc,
  edamamGetFood,
  edamamConfigured,
  EDAMAM_ATTRIBUTION,
} from "./edamam.js";
import { decodeImage, recognizeLabel, parseNutritionLabel, parsedToNormalized } from "./ocr.js";

export { FoodSourceError };
export const ATTRIBUTION = {
  openFoodFacts: OFF_ATTRIBUTION,
  usda: USDA_ATTRIBUTION,
  nutritionix: NUTRITIONIX_ATTRIBUTION,
  edamam: EDAMAM_ATTRIBUTION,
};

const TTL_MS = env.FOOD_CACHE_TTL_DAYS * 86_400_000;
const SEARCH_TTL_MS = 6 * 3_600_000; // 6h
const isFresh = (d: Date) => Date.now() - d.getTime() < TTL_MS;

/** Which tiers are live right now (keys present). */
export function providerStatus() {
  return {
    usda: usdaConfigured(),
    openFoodFacts: true,
    nutritionix: nutritionixConfigured(),
    edamam: edamamConfigured(),
  };
}

// ── cache upsert ────────────────────────────────────────────────────────────

export async function cacheFood(
  nf: NormalizedFood,
  raw?: unknown,
  ownerId?: string | null,
): Promise<Food> {
  const data = {
    source: nf.source,
    sourceId: nf.sourceId,
    barcode: nf.barcode,
    name: nf.name,
    brand: nf.brand,
    imageUrl: nf.imageUrl,
    servingSize: nf.servingSize,
    servingUnit: nf.servingUnit,
    servingGrams: nf.servingGrams,
    caloriesPer100: nf.caloriesPer100,
    proteinPer100: nf.proteinPer100,
    carbsPer100: nf.carbsPer100,
    fatPer100: nf.fatPer100,
    fiberPer100: nf.fiberPer100,
    sugarPer100: nf.sugarPer100,
    sodiumPer100: nf.sodiumPer100,
    micros: (nf.micros ?? undefined) as never,
    perServingOnly: nf.perServingOnly,
    dataPer: nf.dataPer,
    raw: (raw ?? undefined) as never,
    ...(ownerId !== undefined ? { ownerId } : {}),
    fetchedAt: new Date(),
  };
  return prisma.food.upsert({
    where: { source_sourceId: { source: nf.source, sourceId: nf.sourceId } },
    create: data,
    update: data,
  });
}

// ── barcode lookup ─────────────────────────────────────────────────────────

export type BarcodeStatus = "found" | "not_found" | "source_unavailable" | "parsed_from_label";

export interface BarcodeResult {
  food: Food | null;
  status: BarcodeStatus;
  code: string;
  /** which tier answered */
  via: FoodSource | "cache" | "label" | null;
  /** 0..1 — only set for label-parsed results */
  confidence?: number;
  /** true when at least one source in the chain was unreachable */
  degraded: boolean;
}

export interface BarcodeOptions {
  /** raw base64 / data-URL of a Nutrition Facts photo — used only if every API misses */
  image?: string;
  /** required to persist a label-parsed food (it becomes a custom food they own) */
  userId?: string;
}

export async function lookupBarcode(rawCode: string, opts: BarcodeOptions = {}): Promise<BarcodeResult> {
  const code = normalizeBarcode(rawCode);
  const base = { code, degraded: false } as const;
  if (!isPlausibleBarcode(code)) return { ...base, food: null, status: "not_found", via: null };

  let degraded = false;
  const tryStep = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FoodSourceError) {
        degraded = true;
        return null;
      }
      throw e;
    }
  };

  // 1. local cache (fresh only)
  const cached = await prisma.food.findFirst({
    where: {
      OR: [
        { barcode: code },
        { source: "open_food_facts", sourceId: code },
        { source: "nutritionix", barcode: code },
      ],
    },
    orderBy: { fetchedAt: "desc" },
  });
  if (cached && isFresh(cached.fetchedAt)) return { code, degraded, food: cached, status: "found", via: "cache" };

  // 2. USDA (branded, by GTIN/UPC)
  if (usdaConfigured()) {
    const hit = await tryStep(() => usdaLookupUpc(code));
    if (hit) {
      const nf = normalizeUSDA(hit as never);
      nf.barcode = code;
      return { code, degraded, food: await cacheFood(nf, hit), status: "found", via: "usda" };
    }
  }

  // 3. Open Food Facts
  const off = await tryStep(() => offLookupBarcode(code));
  if (off?.product) {
    const nf = normalizeOFF(off.product);
    if (nf?.sourceId) return { code, degraded, food: await cacheFood(nf, off.product), status: "found", via: "open_food_facts" };
  }

  // 4. Nutritionix
  if (nutritionixConfigured()) {
    const nix = await tryStep(() => nutritionixLookupUpc(code));
    if (nix) {
      const nf = normalizeNutritionix(nix);
      if (nf) {
        nf.barcode = code;
        return { code, degraded, food: await cacheFood(nf, nix), status: "found", via: "nutritionix" };
      }
    }
  }

  // 5. Edamam (dark until keys are set)
  if (edamamConfigured()) {
    const eda = await tryStep(() => edamamLookupUpc(code));
    if (eda) {
      const nf = normalizeEdamam(eda);
      if (nf) {
        nf.barcode = code;
        return { code, degraded, food: await cacheFood(nf, eda), status: "found", via: "edamam" };
      }
    }
  }

  // 6. label photo → OCR / nutrition parser
  if (opts.image && opts.userId) {
    const parsed = await parseLabelPhoto(opts.image, { userId: opts.userId, barcode: code });
    if (parsed) return { code, degraded, food: parsed.food, status: "parsed_from_label", via: "label", confidence: parsed.confidence };
  }

  // nothing — stale cache still beats nothing
  if (cached) return { code, degraded, food: cached, status: "found", via: "cache" };
  return { code, degraded, food: null, status: degraded ? "source_unavailable" : "not_found", via: null };
}

// ── label photo → parsed custom food ───────────────────────────────────────

export interface ParsedLabelFood {
  food: Food;
  confidence: number;
}

export async function parseLabelPhoto(
  image: string,
  opts: { userId: string; barcode?: string | null; name?: string },
): Promise<ParsedLabelFood | null> {
  const buf = decodeImage(image);
  if (!buf) throw new FoodSourceError("ocr", "bad_response", "not a decodable image");
  if (buf.length > env.FOOD_LABEL_MAX_BYTES)
    throw new FoodSourceError("ocr", "bad_response", "image too large");

  const text = await recognizeLabel(buf);
  const parsed = parseNutritionLabel(text);
  if (parsed.calories == null && parsed.protein == null && parsed.carbs == null && parsed.fat == null) {
    return null; // OCR produced nothing usable
  }

  const sourceId = `label_${opts.barcode ? `${opts.barcode}_` : ""}${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const nf = parsedToNormalized(parsed, {
    sourceId,
    name: opts.name?.trim() || (opts.barcode ? `Label ${opts.barcode}` : "Food from label"),
    barcode: opts.barcode ?? null,
  });
  const food = await cacheFood(nf, { ocrText: text.slice(0, 4000), parsed }, opts.userId);
  return { food, confidence: parsed.confidence };
}

// ── text search ────────────────────────────────────────────────────────────

export interface SearchResult {
  source: FoodSource;
  sourceId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  caloriesPer100: number;
  proteinPer100: number;
  servingGrams: number | null;
  servingUnit: string | null;
  perServingOnly: boolean;
  dataPer: string;
}

const toSearchResult = (nf: NormalizedFood): SearchResult => ({
  source: nf.source,
  sourceId: nf.sourceId,
  name: nf.name,
  brand: nf.brand,
  imageUrl: nf.imageUrl,
  caloriesPer100: nf.caloriesPer100,
  proteinPer100: nf.proteinPer100,
  servingGrams: nf.servingGrams,
  servingUnit: nf.servingUnit,
  perServingOnly: nf.perServingOnly,
  dataPer: nf.dataPer,
});

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  sources: { usda: boolean; nutritionix: boolean; edamam: boolean; custom: number };
  /** which tier the external results came from */
  via: FoodSource | null;
  degraded: boolean; // a source was unavailable
}

export async function searchFoods(rawQuery: string, userId: string): Promise<SearchResponse> {
  const query = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
  const status = providerStatus();
  const emptySources = { usda: status.usda, nutritionix: status.nutritionix, edamam: status.edamam, custom: 0 };
  if (query.length < 2) return { query, results: [], sources: emptySources, via: null, degraded: false };

  // the user's own custom foods always match first
  const customs = await prisma.food.findMany({
    where: { source: "custom", ownerId: userId, name: { contains: query, mode: "insensitive" } },
    take: 8,
  });
  const customResults: SearchResult[] = customs.map((c) => ({
    source: "custom",
    sourceId: c.sourceId,
    name: c.name,
    brand: c.brand,
    imageUrl: c.imageUrl,
    caloriesPer100: c.caloriesPer100,
    proteinPer100: c.proteinPer100,
    servingGrams: c.servingGrams,
    servingUnit: c.servingUnit,
    perServingOnly: c.perServingOnly,
    dataPer: c.dataPer,
  }));

  // search cache (external results only)
  const cache = await prisma.foodSearchCache.findUnique({ where: { query } });
  if (cache && Date.now() - cache.createdAt.getTime() < SEARCH_TTL_MS) {
    const cached = cache.results as unknown as SearchResult[];
    return {
      query,
      results: [...customResults, ...cached],
      sources: { ...emptySources, custom: customResults.length },
      via: cached[0]?.source ?? null,
      degraded: false,
    };
  }

  let degraded = false;
  const run = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FoodSourceError) {
        degraded = true;
        return [];
      }
      throw e;
    }
  };

  // walk the chain, stop at the first tier that returns anything
  let external: SearchResult[] = [];
  let via: FoodSource | null = null;
  let normalized: NormalizedFood[] = [];

  if (status.usda) {
    const hits = await run(() => usdaSearch(query, 25));
    normalized = hits.map((h) => normalizeUSDA(h as never));
    if (normalized.length) via = "usda";
  }
  if (!normalized.length) {
    const hits = await run(() => offSearch(query, 20));
    normalized = hits.map((p) => normalizeOFF(p)).filter((x): x is NormalizedFood => !!x && !!x.sourceId);
    if (normalized.length) via = "open_food_facts";
  }
  if (!normalized.length && status.nutritionix) {
    const hits = await run(() => nutritionixSearch(query, 20));
    normalized = hits.map((h) => normalizeNutritionix(h)).filter((x): x is NormalizedFood => !!x);
    if (normalized.length) via = "nutritionix";
  }
  if (!normalized.length && status.edamam) {
    const hits = await run(() => edamamSearch(query, 20));
    normalized = hits.map((h) => normalizeEdamam(h)).filter((x): x is NormalizedFood => !!x);
    if (normalized.length) via = "edamam";
  }

  external = normalized.map(toSearchResult);

  if (normalized.length) {
    // backfill: warm the Food cache for the top hits + the search cache
    await Promise.allSettled(normalized.slice(0, 10).map((nf) => cacheFood(nf)));
    await prisma.foodSearchCache.upsert({
      where: { query },
      create: { query, results: external as never },
      update: { results: external as never, createdAt: new Date() },
    });
  }

  return {
    query,
    results: [...customResults, ...external],
    sources: { ...emptySources, custom: customResults.length },
    via,
    degraded,
  };
}

// ── resolve one food (for the serving screen / logging) ─────────────────────

export async function resolveFood(
  source: FoodSource,
  sourceId: string,
  userId: string,
): Promise<Food | null> {
  const cached = await prisma.food.findUnique({
    where: { source_sourceId: { source, sourceId } },
  });
  if (source === "custom") {
    return cached && cached.ownerId === userId ? cached : null;
  }
  if (cached && isFresh(cached.fetchedAt)) return cached;

  try {
    if (source === "open_food_facts") {
      const { product } = await offLookupBarcode(sourceId);
      if (!product) return cached;
      const nf = normalizeOFF(product);
      return nf ? cacheFood(nf, product) : cached;
    }
    if (source === "usda") {
      const raw = await usdaGetFood(sourceId);
      const nf = normalizeUSDA(raw as never);
      return cacheFood(nf, raw);
    }
    if (source === "nutritionix") {
      const item = sourceId.startsWith(NIX_COMMON_PREFIX)
        ? await nutritionixNaturalNutrients(sourceId.slice(NIX_COMMON_PREFIX.length))
        : await nutritionixGetItem(sourceId);
      if (!item) return cached;
      const nf = normalizeNutritionix(item);
      return nf ? cacheFood(nf, item) : cached;
    }
    if (source === "edamam") {
      const item = await edamamGetFood(sourceId);
      if (!item) return cached;
      const nf = normalizeEdamam(item);
      return nf ? cacheFood(nf, item) : cached;
    }
  } catch (e) {
    if (e instanceof FoodSourceError) return cached; // stale beats nothing
    throw e;
  }
  return cached;
}
