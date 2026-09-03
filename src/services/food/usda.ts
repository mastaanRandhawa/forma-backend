/**
 * USDA FoodData Central client — generic / raw / cooked foods and additional
 * branded items. The API key is read from the server environment only and is
 * never sent to the client; all USDA traffic is proxied through /api/v1/food/*.
 *
 * FoodData Central data is in the public domain (U.S. Government work / CC0).
 */
import { env } from "../../env.js";
import { FoodSourceError } from "./openFoodFacts.js";

const BASE = "https://api.nal.usda.gov/fdc/v1";

export const usdaConfigured = () => env.USDA_FDC_API_KEY.length > 0;

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (res.status === 429) throw new FoodSourceError("usda", "rate_limited", "USDA rate limited");
    if (res.status === 404) throw new FoodSourceError("usda", "not_found", "USDA 404");
    if (res.status === 403) throw new FoodSourceError("usda", "unavailable", "USDA key rejected");
    if (!res.ok) throw new FoodSourceError("usda", "bad_response", `USDA ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof FoodSourceError) throw e;
    throw new FoodSourceError("usda", "unavailable", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export interface USDASearchHit {
  fdcId: number;
  description: string;
  dataType?: string;
  brandName?: string;
  brandOwner?: string;
  gtinUpc?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodNutrients?: { nutrientNumber?: string; number?: string; value?: number; amount?: number }[];
}

/**
 * Barcode → the branded USDA item whose GTIN/UPC matches, or null. USDA stores
 * UPC-A as 12 digits; we compare on the trailing digits so an EAN-13 with a
 * leading zero still matches.
 */
export async function usdaLookupUpc(code: string): Promise<USDASearchHit | null> {
  if (!usdaConfigured()) throw new FoodSourceError("usda", "unavailable", "USDA_FDC_API_KEY not set");
  const data = (await fetchJson(`${BASE}/foods/search?api_key=${env.USDA_FDC_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: code, dataType: ["Branded"], pageSize: 10 }),
  })) as { foods?: USDASearchHit[] };
  const digits = code.replace(/\D/g, "");
  const tail = digits.replace(/^0+/, "");
  return (
    (data.foods ?? []).find((f) => {
      const g = (f.gtinUpc ?? "").replace(/\D/g, "");
      return g && (g === digits || g.replace(/^0+/, "") === tail);
    }) ?? null
  );
}

export async function usdaSearch(query: string, pageSize = 25): Promise<USDASearchHit[]> {
  if (!usdaConfigured()) throw new FoodSourceError("usda", "unavailable", "USDA_FDC_API_KEY not set");
  const data = (await fetchJson(`${BASE}/foods/search?api_key=${env.USDA_FDC_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      pageSize,
      dataType: ["Foundation", "SR Legacy", "Survey (FNDDS)", "Branded"],
    }),
  })) as { foods?: USDASearchHit[] };
  return data.foods ?? [];
}

export async function usdaGetFood(fdcId: string): Promise<Record<string, unknown>> {
  if (!usdaConfigured()) throw new FoodSourceError("usda", "unavailable", "USDA_FDC_API_KEY not set");
  return (await fetchJson(
    `${BASE}/food/${encodeURIComponent(fdcId)}?api_key=${env.USDA_FDC_API_KEY}`,
  )) as Record<string, unknown>;
}

export const USDA_ATTRIBUTION = {
  name: "USDA FoodData Central",
  url: "https://fdc.nal.usda.gov",
  license: "Public domain (U.S. Government work)",
  note: "Source: USDA FoodData Central.",
};
