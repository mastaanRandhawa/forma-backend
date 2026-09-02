/**
 * Label-photo fallback — the last resort when no data source (DB, USDA, Open
 * Food Facts, Nutritionix, Edamam) has a product. The user photographs the
 * Nutrition Facts panel; we OCR it and parse the panel heuristically.
 *
 *   recognizeLabel(buffer)  → raw text            (tesseract.js, impure)
 *   parseNutritionLabel(txt) → ParsedLabel         (pure, unit tested)
 *   parsedToNormalized(...)  → NormalizedFood       (pure)
 *
 * Output is deliberately low-trust: it becomes a `custom` Food owned by the user,
 * flagged so the UI can ask them to double-check the numbers.
 */
import os from "node:os";
import path from "node:path";
import { createWorker } from "tesseract.js";
import { FoodSourceError } from "./openFoodFacts.js";
import type { NormalizedFood } from "./normalize.js";

/**
 * Where tesseract.js caches its WASM core + `eng.traineddata` (~12 MB, fetched
 * from the CDN on first use). Overridable so a container can pre-seed it or point
 * at a persistent volume. `TESSDATA_PREFIX` (a dir holding `eng.traineddata`)
 * skips the download entirely when set.
 */
const CACHE_PATH = process.env.TESSERACT_CACHE_PATH || path.join(os.tmpdir(), "forma-tesseract");
const LANG_PATH = process.env.TESSDATA_PREFIX || undefined;

export interface ParsedLabel {
  /** grams in one serving, when the panel states it */
  servingGrams: number | null;
  /** serving description text, e.g. "2/3 cup" */
  servingText: string | null;
  /** true when the panel is expressed per 100 g/ml rather than per serving */
  per100: boolean;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  sugar: number | null;
  sodiumMg: number | null;
  /** 0..1 — share of the core fields (cal/protein/carbs/fat) we actually found */
  confidence: number;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const n = (s: string | undefined): number | null => {
  if (s == null) return null;
  const v = Number.parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

/** First capture group of the first matching pattern. */
function grab(text: string, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const v = n(m[1]);
      if (v != null) return v;
    }
  }
  return null;
}

export function parseNutritionLabel(raw: string): ParsedLabel {
  // normalize: lowercase, collapse whitespace, unify unicode fractions
  const text = raw
    .toLowerCase()
    .replace(/¼/g, "1/4")
    .replace(/½/g, "1/2")
    .replace(/¾/g, "3/4")
    .replace(/[|]/g, " ")
    .replace(/[ \t]+/g, " ");

  const per100 = /per\s*100\s*(g|ml|gram)/.test(text);

  let servingGrams = grab(text, [
    new RegExp(String.raw`serving size[^\n(]*\(\s*${NUM}\s*g`, "i"),
    new RegExp(String.raw`serving size[^\n]*?${NUM}\s*g\b`, "i"),
    new RegExp(String.raw`per\s*${NUM}\s*g\b`, "i"),
  ]);
  if (servingGrams != null && (servingGrams <= 0 || servingGrams > 5000)) servingGrams = null;

  const servingText =
    /serving size\s*[:\-]?\s*([^\n(]+?)(?:\(|\n|$)/i.exec(text)?.[1]?.trim().replace(/\s+/g, " ") || null;

  const calories = grab(text, [
    new RegExp(String.raw`calories\s*[:\-]?\s*${NUM}`, "i"),
    new RegExp(String.raw`energy[^\n]*?${NUM}\s*kcal`, "i"),
    new RegExp(String.raw`${NUM}\s*kcal`, "i"),
  ]);

  const protein = grab(text, [
    new RegExp(String.raw`protein\s*[:\-]?\s*${NUM}\s*g`, "i"),
    new RegExp(String.raw`protein\s*[:\-]?\s*${NUM}`, "i"),
  ]);
  const carbs = grab(text, [
    new RegExp(String.raw`(?:total\s*)?carbohydrate\w*\s*[:\-]?\s*${NUM}\s*g`, "i"),
    new RegExp(String.raw`carb\w*\s*[:\-]?\s*${NUM}\s*g`, "i"),
  ]);
  const fat = grab(text, [
    new RegExp(String.raw`(?:total\s*)?fat\s*[:\-]?\s*${NUM}\s*g`, "i"),
  ]);
  const fiber = grab(text, [
    new RegExp(String.raw`(?:dietary\s*)?fib(?:re|er)\s*[:\-]?\s*${NUM}\s*g`, "i"),
  ]);
  const sugar = grab(text, [
    new RegExp(String.raw`(?:total\s*)?sugars?\s*[:\-]?\s*${NUM}\s*g`, "i"),
  ]);

  let sodiumMg = grab(text, [new RegExp(String.raw`sodium\s*[:\-]?\s*${NUM}\s*mg`, "i")]);
  if (sodiumMg == null) {
    const sodiumG = grab(text, [new RegExp(String.raw`sodium\s*[:\-]?\s*${NUM}\s*g\b`, "i")]);
    if (sodiumG != null) sodiumMg = sodiumG * 1000;
  }

  const core = [calories, protein, carbs, fat];
  const confidence = core.filter((v) => v != null).length / core.length;

  return {
    servingGrams,
    servingText,
    per100,
    calories,
    protein,
    carbs,
    fat,
    fiber,
    sugar,
    sodiumMg,
    confidence,
  };
}

/**
 * ParsedLabel → NormalizedFood (source "custom"). If the panel gave a gram
 * weight and reads per-serving, values are scaled to per-100 g; a per-100 panel
 * is taken as-is; otherwise we keep the raw per-serving numbers and set
 * `perServingOnly`.
 */
export function parsedToNormalized(
  parsed: ParsedLabel,
  opts: { sourceId: string; name: string; barcode?: string | null },
): NormalizedFood {
  const grams = parsed.servingGrams;
  const scale = !parsed.per100 && grams && grams > 0 ? 100 / grams : 1;
  const perServingOnly = !parsed.per100 && !(grams && grams > 0);
  const v = (x: number | null): number => (x == null ? 0 : Math.round(x * scale * 10) / 10);

  return {
    source: "custom",
    sourceId: opts.sourceId,
    barcode: opts.barcode ?? null,
    name: opts.name,
    brand: null,
    imageUrl: null,
    servingSize: grams ?? null,
    servingUnit: grams ? "g" : parsed.servingText ? "serving" : null,
    servingGrams: grams ?? null,
    caloriesPer100: Math.round(v(parsed.calories)),
    proteinPer100: v(parsed.protein),
    carbsPer100: v(parsed.carbs),
    fatPer100: v(parsed.fat),
    fiberPer100: parsed.fiber == null ? null : v(parsed.fiber),
    sugarPer100: parsed.sugar == null ? null : v(parsed.sugar),
    sodiumPer100: parsed.sodiumMg == null ? null : Math.round(parsed.sodiumMg * scale),
    micros: null,
    perServingOnly,
    dataPer: perServingOnly ? "serving" : "100g",
  };
}

/** Run OCR over a label image. Throws FoodSourceError on failure. */
export async function recognizeLabel(image: Buffer): Promise<string> {
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  try {
    worker = await createWorker("eng", undefined, {
      cachePath: CACHE_PATH,
      ...(LANG_PATH ? { langPath: LANG_PATH } : {}),
    });
    const { data } = await worker.recognize(image);
    return data.text ?? "";
  } catch (e) {
    throw new FoodSourceError("ocr", "unavailable", (e as Error).message);
  } finally {
    await worker?.terminate().catch(() => {});
  }
}

/** Decode a `data:` URL or bare base64 string to a Buffer. Returns null if not an image. */
export function decodeImage(input: string): Buffer | null {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(input.trim());
  const b64 = m ? m[2] : /^[A-Za-z0-9+/=\s]+$/.test(input.trim()) ? input.trim() : null;
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
