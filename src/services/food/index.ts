/**
 * Food provider — the single abstraction the API layer talks to. Orchestrates
 * the two sources, the DB-backed cache, and the search cache. New providers
 * (restaurant DBs, Health Canada, verified foods) would slot in here without the
 * routes changing.
 *
 * Cache strategy:
 *   - barcode → cached `Food` row (unique on [source, sourceId]); re-fetched from
 *     OFF only when older than FOOD_CACHE_TTL_DAYS.
 *   - text search → `FoodSearchCache` keyed by normalized query, short TTL.
 *   - USDA detail → cached `Food` row.
 * The user's `FoodLog` rows are permanent and independent of all of this.
 */
import type { Food } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { env } from "../../env.js";
import {
  normalizeOFF,
  normalizeUSDA,
  normalizeBarcode,
  isPlausibleBarcode,
  type NormalizedFood,
  type FoodSource,
} from "./normalize.js";
import { offLookupBarcode, OFF_ATTRIBUTION, FoodSourceError } from "./openFoodFacts.js";
import { usdaSearch, usdaGetFood, usdaConfigured, USDA_ATTRIBUTION } from "./usda.js";

export { FoodSourceError };
export const ATTRIBUTION = { openFoodFacts: OFF_ATTRIBUTION, usda: USDA_ATTRIBUTION };

const TTL_MS = env.FOOD_CACHE_TTL_DAYS * 86_400_000;
const SEARCH_TTL_MS = 6 * 3_600_000; // 6h
const isFresh = (d: Date) => Date.now() - d.getTime() < TTL_MS;

// ── cache upsert ────────────────────────────────────────────────────────────

export async function cacheFood(nf: NormalizedFood, raw?: unknown): Promise<Food> {
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
    fetchedAt: new Date(),
  };
  return prisma.food.upsert({
    where: { source_sourceId: { source: nf.source, sourceId: nf.sourceId } },
    create: data,
    update: data,
  });
}

// ── barcode lookup ─────────────────────────────────────────────────────────

export interface BarcodeResult {
  food: Food | null;
  status: "found" | "not_found" | "source_unavailable";
  code: string;
}

export async function lookupBarcode(rawCode: string): Promise<BarcodeResult> {
  const code = normalizeBarcode(rawCode);
  if (!isPlausibleBarcode(code)) return { food: null, status: "not_found", code };

  // 1. local cache — never re-hit OFF for a barcode we already know & is fresh
  const cached = await prisma.food.findFirst({
    where: { OR: [{ barcode: code }, { source: "open_food_facts", sourceId: code }] },
    orderBy: { fetchedAt: "desc" },
  });
  if (cached && isFresh(cached.fetchedAt)) return { food: cached, status: "found", code };

  // 2. Open Food Facts
  try {
    const { product } = await offLookupBarcode(code);
    if (!product) return { food: cached ?? null, status: cached ? "found" : "not_found", code };
    const nf = normalizeOFF(product);
    if (!nf || !nf.sourceId) return { food: cached ?? null, status: cached ? "found" : "not_found", code };
    return { food: await cacheFood(nf, product), status: "found", code };
  } catch (e) {
    if (e instanceof FoodSourceError) {
      // stale cache beats nothing when the source is down (offline resilience)
      if (cached) return { food: cached, status: "found", code };
      return { food: null, status: "source_unavailable", code };
    }
    throw e;
  }
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
  sources: { usda: boolean; custom: number };
  degraded: boolean; // a source was unavailable
}

export async function searchFoods(rawQuery: string, userId: string): Promise<SearchResponse> {
  const query = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
  if (query.length < 2) return { query, results: [], sources: { usda: usdaConfigured(), custom: 0 }, degraded: false };

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

  // search cache
  const cache = await prisma.foodSearchCache.findUnique({ where: { query } });
  if (cache && Date.now() - cache.createdAt.getTime() < SEARCH_TTL_MS) {
    return {
      query,
      results: [...customResults, ...(cache.results as unknown as SearchResult[])],
      sources: { usda: usdaConfigured(), custom: customResults.length },
      degraded: false,
    };
  }

  let usdaResults: SearchResult[] = [];
  let degraded = false;
  try {
    const hits = await usdaSearch(query, 25);
    const normalized = hits.map((h) => normalizeUSDA(h as never));
    usdaResults = normalized.map(toSearchResult);
    // warm the Food cache for the top hits so the detail call is instant
    await Promise.allSettled(normalized.slice(0, 10).map((nf) => cacheFood(nf)));
    await prisma.foodSearchCache.upsert({
      where: { query },
      create: { query, results: usdaResults as never },
      update: { results: usdaResults as never, createdAt: new Date() },
    });
  } catch (e) {
    if (e instanceof FoodSourceError) degraded = true;
    else throw e;
  }

  return {
    query,
    results: [...customResults, ...usdaResults],
    sources: { usda: usdaConfigured(), custom: customResults.length },
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
  } catch (e) {
    if (e instanceof FoodSourceError) return cached; // stale beats nothing
    throw e;
  }
  return cached;
}
