/**
 * Nutritionix client — branded packaged foods, restaurant items and UPC lookup.
 *
 * Keys (`x-app-id` / `x-app-key`) are read from the server environment only and
 * are never sent to the client; all Nutritionix traffic is proxied through
 * /api/v1/food/*. Empty keys ⇒ this tier is skipped by the fallback chain.
 *
 * Endpoints used (all v2):
 *   GET  /search/instant?query=      → typeahead: { common[], branded[] }
 *   GET  /search/item?upc=           → one branded item by barcode
 *   GET  /search/item?nix_item_id=   → one branded item by id
 *   POST /natural/nutrients {query}  → full nutrition for a common/generic food
 *
 * Nutritionix numbers are PER SERVING; `nf_serving_weight_grams` gives the gram
 * weight of that serving when known.
 */
import { env } from "../../env.js";
import { FoodSourceError } from "./openFoodFacts.js";

const BASE = "https://trackapi.nutritionix.com/v2";

export const nutritionixConfigured = () =>
  env.NUTRITIONIX_APP_ID.length > 0 && env.NUTRITIONIX_APP_KEY.length > 0;

/** Common (generic) foods have no stable id — we key them by name with a prefix. */
export const NIX_COMMON_PREFIX = "common:";

export interface NutritionixFood {
  food_name?: string;
  brand_name?: string;
  nix_item_id?: string;
  nix_brand_name?: string;
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

interface InstantResponse {
  common?: NutritionixFood[];
  branded?: NutritionixFood[];
}

async function fetchJson(path: string, init?: RequestInit, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "x-app-id": env.NUTRITIONIX_APP_ID,
        "x-app-key": env.NUTRITIONIX_APP_KEY,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429) throw new FoodSourceError("nutritionix", "rate_limited", "Nutritionix rate limited");
    if (res.status === 404) throw new FoodSourceError("nutritionix", "not_found", "Nutritionix 404");
    if (res.status === 401 || res.status === 403)
      throw new FoodSourceError("nutritionix", "unavailable", "Nutritionix keys rejected");
    if (!res.ok) throw new FoodSourceError("nutritionix", "bad_response", `Nutritionix ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof FoodSourceError) throw e;
    throw new FoodSourceError("nutritionix", "unavailable", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** UPC → one branded food (or null when Nutritionix has no such item). */
export async function nutritionixLookupUpc(upc: string): Promise<NutritionixFood | null> {
  if (!nutritionixConfigured()) throw new FoodSourceError("nutritionix", "unavailable", "keys not set");
  try {
    const data = (await fetchJson(`/search/item?upc=${encodeURIComponent(upc)}`)) as { foods?: NutritionixFood[] };
    return data.foods?.[0] ?? null;
  } catch (e) {
    if (e instanceof FoodSourceError && e.reason === "not_found") return null;
    throw e;
  }
}

/** Typeahead search → merged branded + common list (branded first). */
export async function nutritionixSearch(query: string, limit = 20): Promise<NutritionixFood[]> {
  if (!nutritionixConfigured()) throw new FoodSourceError("nutritionix", "unavailable", "keys not set");
  const data = (await fetchJson(
    `/search/instant?query=${encodeURIComponent(query)}&branded=true&common=true`,
  )) as InstantResponse;
  const branded = (data.branded ?? []).slice(0, limit);
  const common = (data.common ?? []).slice(0, Math.max(0, limit - branded.length));
  return [...branded, ...common];
}

/** Full nutrition for one branded item by id. */
export async function nutritionixGetItem(nixItemId: string): Promise<NutritionixFood | null> {
  if (!nutritionixConfigured()) throw new FoodSourceError("nutritionix", "unavailable", "keys not set");
  const data = (await fetchJson(
    `/search/item?nix_item_id=${encodeURIComponent(nixItemId)}`,
  )) as { foods?: NutritionixFood[] };
  return data.foods?.[0] ?? null;
}

/** Full nutrition for a common/generic food, phrased as a natural query. */
export async function nutritionixNaturalNutrients(query: string): Promise<NutritionixFood | null> {
  if (!nutritionixConfigured()) throw new FoodSourceError("nutritionix", "unavailable", "keys not set");
  const data = (await fetchJson(`/natural/nutrients`, {
    method: "POST",
    body: JSON.stringify({ query }),
  })) as { foods?: NutritionixFood[] };
  return data.foods?.[0] ?? null;
}

export const NUTRITIONIX_ATTRIBUTION = {
  name: "Nutritionix",
  url: "https://www.nutritionix.com",
  license: "Nutritionix API Terms of Service",
  note: "Nutrition data provided by Nutritionix.",
};
