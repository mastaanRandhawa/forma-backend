/**
 * Open Food Facts client — packaged products & barcode lookup.
 *
 * Used ONLY for barcode lookup (per-IP ~15 req/min). We never call the OFF
 * search endpoint for search-as-you-type; text search goes through USDA. Every
 * request carries an identifying User-Agent as OFF asks.
 *
 * Data © Open Food Facts contributors, ODbL. Provenance is preserved on every
 * cached row (`Food.source = open_food_facts`, `sourceId`, `barcode`).
 */
import { env } from "../../env.js";

const BASE = "https://world.openfoodfacts.org";
const FIELDS = [
  "code", "product_name", "generic_name", "brands", "quantity", "serving_size",
  "serving_quantity", "image_front_url", "image_url", "nutriments",
  "nutrition_data_per", "categories_tags", "countries_tags",
].join(",");

export class FoodSourceError extends Error {
  constructor(
    public source: string,
    public reason: "unavailable" | "rate_limited" | "not_found" | "bad_response",
    message: string,
  ) {
    super(message);
  }
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": env.OPEN_FOOD_FACTS_USER_AGENT, Accept: "application/json" },
    });
    if (res.status === 429) throw new FoodSourceError("open_food_facts", "rate_limited", "OFF rate limited");
    if (!res.ok) throw new FoodSourceError("open_food_facts", "bad_response", `OFF ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof FoodSourceError) throw e;
    throw new FoodSourceError("open_food_facts", "unavailable", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export interface OFFLookup {
  product: Record<string, unknown> | null;
  status: number;
}

/** Barcode → raw product payload (or null when OFF has no such product). */
export async function offLookupBarcode(code: string): Promise<OFFLookup> {
  const data = (await fetchJson(
    `${BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`,
  )) as { status?: number; product?: Record<string, unknown> };
  if (data?.status === 1 && data.product) return { product: data.product, status: 1 };
  return { product: null, status: data?.status ?? 0 };
}

/**
 * Text search over Open Food Facts. Kept OFF the search-as-you-type hot path
 * (see module header) — the fallback chain calls this only after USDA misses,
 * so the volume stays low.
 */
export async function offSearch(query: string, pageSize = 20): Promise<Record<string, unknown>[]> {
  const url =
    `${BASE}/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=${pageSize}&fields=${FIELDS}`;
  const data = (await fetchJson(url, 8000)) as { products?: Record<string, unknown>[] };
  return data.products ?? [];
}

export const OFF_ATTRIBUTION = {
  name: "Open Food Facts",
  url: "https://world.openfoodfacts.org",
  license: "Open Database License (ODbL) v1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  note: "Product data © Open Food Facts contributors, made available under the ODbL.",
};
