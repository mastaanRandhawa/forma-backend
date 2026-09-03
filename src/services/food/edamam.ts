/**
 * Edamam Food Database API client — generic foods + some UPC coverage.
 *
 * Wired into the fallback chain but DARK until both `EDAMAM_APP_ID` and
 * `EDAMAM_APP_KEY` are set. Keys stay server-side; traffic is proxied through
 * /api/v1/food/*.
 *
 * Endpoint used:
 *   GET /api/food-database/v2/parser?ingr=<q>  (or &upc=<code>)
 *     → { hints: [{ food: { foodId, label, brand, nutrients, image }, measures }] }
 *   Parser `nutrients` are PER 100 G (ENERC_KCAL, PROCNT, FAT, CHOCDF, FIBTG).
 */
import { env } from "../../env.js";
import { FoodSourceError } from "./openFoodFacts.js";

const BASE = "https://api.edamam.com/api/food-database/v2";

export const edamamConfigured = () =>
  env.EDAMAM_APP_ID.length > 0 && env.EDAMAM_APP_KEY.length > 0;

export interface EdamamFood {
  foodId?: string;
  label?: string;
  brand?: string;
  knownAs?: string;
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

interface ParserResponse {
  hints?: { food?: EdamamFood }[];
  parsed?: { food?: EdamamFood }[];
}

function auth(): string {
  return `app_id=${encodeURIComponent(env.EDAMAM_APP_ID)}&app_key=${encodeURIComponent(env.EDAMAM_APP_KEY)}`;
}

async function parser(qs: string, timeoutMs = 8000): Promise<EdamamFood[]> {
  if (!edamamConfigured()) throw new FoodSourceError("edamam", "unavailable", "keys not set");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/parser?${auth()}&${qs}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 429) throw new FoodSourceError("edamam", "rate_limited", "Edamam rate limited");
    if (res.status === 401 || res.status === 403)
      throw new FoodSourceError("edamam", "unavailable", "Edamam keys rejected");
    if (res.status === 404) return [];
    if (!res.ok) throw new FoodSourceError("edamam", "bad_response", `Edamam ${res.status}`);
    const data = (await res.json()) as ParserResponse;
    const hints = (data.hints ?? []).map((h) => h.food).filter(Boolean) as EdamamFood[];
    const parsed = (data.parsed ?? []).map((h) => h.food).filter(Boolean) as EdamamFood[];
    return [...parsed, ...hints];
  } catch (e) {
    if (e instanceof FoodSourceError) throw e;
    throw new FoodSourceError("edamam", "unavailable", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** UPC → first matching food (or null). */
export async function edamamLookupUpc(upc: string): Promise<EdamamFood | null> {
  const foods = await parser(`upc=${encodeURIComponent(upc)}`);
  return foods[0] ?? null;
}

/** Text search → foods (parsed match first, then hints). */
export async function edamamSearch(query: string, limit = 20): Promise<EdamamFood[]> {
  const foods = await parser(`ingr=${encodeURIComponent(query)}`);
  return foods.slice(0, limit);
}

/** Resolve one food by its Edamam foodId via a fresh parser call keyed on the id. */
export async function edamamGetFood(foodId: string): Promise<EdamamFood | null> {
  const foods = await parser(`ingr=${encodeURIComponent(foodId)}`).catch(() => [] as EdamamFood[]);
  return foods.find((f) => f.foodId === foodId) ?? foods[0] ?? null;
}

export const EDAMAM_ATTRIBUTION = {
  name: "Edamam",
  url: "https://www.edamam.com",
  license: "Edamam API License",
  note: "Nutrition data provided by Edamam.",
};
