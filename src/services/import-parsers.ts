/**
 * Parsers for workout history exported from other apps (Strong, Hevy, FitNotes) and
 * for body weight from an Apple Health export. Pure functions: text in, plain objects out.
 *
 * The column layouts below are what those apps are known to export, matched by header
 * name (case-insensitive, extra columns ignored) so small variations still parse. They
 * are written from the documented exports, not checked against every app version:
 * the import endpoint has a dry run so a person can see what will be read first.
 *
 * Times without a zone are read as UTC. Weights are converted to kilograms.
 */

const LB_TO_KG = 0.45359237;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type ImportFormat = "strong" | "hevy" | "fitnotes";
export type WeightUnit = "kg" | "lb";

export interface ParsedSet {
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  durationSeconds: number | null;
  distanceM: number | null;
  isWarmup: boolean;
}
export interface ParsedExercise {
  name: string;
  sets: ParsedSet[];
}
export interface ParsedWorkout {
  name: string;
  startedAt: Date;
  durationSeconds: number;
  exercises: ParsedExercise[];
}
export interface ParseResult {
  format: ImportFormat;
  workouts: ParsedWorkout[];
  /** rows that could not be read, with the reason (never silently dropped) */
  warnings: string[];
  /** what the file says about weight units, when it says so */
  unitInFile: WeightUnit | null;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180 style: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Rows as objects keyed by normalised header: "Weight (kgs)" → "weight kgs". */
function table(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const grid = parseCsv(text);
  if (!grid.length) return { headers: [], rows: [] };
  const headers = grid[0].map(norm);
  const rows = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows };
}

export function detectFormat(text: string): ImportFormat | null {
  const h = new Set(table(text).headers);
  if (h.has("exercise name") && h.has("set order")) return "strong";
  if (h.has("exercise title") && (h.has("start time") || h.has("set index"))) return "hevy";
  if (h.has("exercise") && h.has("date") && ([...h].some((x) => x.startsWith("weight")) || h.has("reps"))) return "fitnotes";
  return null;
}

// ── value helpers ───────────────────────────────────────────────────────────

const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "2023-01-15 10:30:00", "2023-01-15T10:30:00Z", "15 Jan 2023, 10:30", "2023-01-15". Unzoned = UTC. */
export function parseWhen(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const hevy = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/.exec(t);
  if (hevy && MONTHS[hevy[2].toLowerCase()] != null) {
    return new Date(Date.UTC(+hevy[3], MONTHS[hevy[2].toLowerCase()], +hevy[1], +(hevy[4] ?? 12), +(hevy[5] ?? 0)));
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (iso) {
    const [, y, mo, d, h, mi, sec, zone] = iso;
    const base = Date.UTC(+y, +mo - 1, +d, +(h ?? 12), +(mi ?? 0), +(sec ?? 0));
    if (!zone || zone === "Z") return new Date(base);
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    return new Date(base - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000);
  }
  const fallback = new Date(t);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** "1h 5m", "45m", "1h", "1:05:00", "65:00", "90" (seconds) → seconds. */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const hm = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/.exec(t);
  if (hm && (hm[1] || hm[2] || hm[3])) return +(hm[1] ?? 0) * 3600 + +(hm[2] ?? 0) * 60 + +(hm[3] ?? 0);
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (clock) return clock[3] != null ? +clock[1] * 3600 + +clock[2] * 60 + +clock[3] : +clock[1] * 60 + +clock[2];
  const n = num(t);
  return n != null ? Math.round(n) : null;
}

const toKg = (v: number | null, unit: WeightUnit) => (v == null ? null : round2(unit === "lb" ? v * LB_TO_KG : v));

const DISTANCE_TO_M: Record<string, number> = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048, yd: 0.9144 };

/** Group parsed sets into workouts, keeping exercise and set order as they appeared. */
class WorkoutBuilder {
  private map = new Map<string, ParsedWorkout & { _ex: Map<string, ParsedExercise> }>();
  add(key: string, meta: { name: string; startedAt: Date; durationSeconds: number }, exercise: string, set: ParsedSet) {
    let w = this.map.get(key);
    if (!w) {
      w = { ...meta, exercises: [], _ex: new Map() };
      this.map.set(key, w);
    }
    let e = w._ex.get(exercise);
    if (!e) {
      e = { name: exercise, sets: [] };
      w._ex.set(exercise, e);
      w.exercises.push(e);
    }
    e.sets.push(set);
  }
  done(): ParsedWorkout[] {
    return [...this.map.values()]
      .map(({ _ex: _unused, ...w }) => w)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
}

const emptySet = (): ParsedSet => ({ weightKg: null, reps: null, rpe: null, durationSeconds: null, distanceM: null, isWarmup: false });
/** Exports write 0 for "not applicable": a timed set has no reps, and a 0 kg set with no reps carries no load. */
const clean = (s: ParsedSet): ParsedSet => ({
  ...s,
  reps: s.reps === 0 ? null : s.reps,
  weightKg: s.weightKg === 0 && (s.reps === 0 || s.reps == null) ? null : s.weightKg,
});
const hasData = (s: ParsedSet) => s.reps != null || s.durationSeconds != null || (s.weightKg != null && s.weightKg > 0) || s.distanceM != null;

// ── Strong ──────────────────────────────────────────────────────────────────
// Date, Workout Name, Duration, Exercise Name, Set Order, Weight, Reps, Distance, Seconds, Notes, Workout Notes, RPE
function parseStrong(text: string, units: WeightUnit): ParseResult {
  const { rows } = table(text);
  const b = new WorkoutBuilder();
  const warnings: string[] = [];
  rows.forEach((r, i) => {
    const when = parseWhen(r["date"]);
    const exercise = r["exercise name"];
    if (!when || !exercise) return void warnings.push(`Row ${i + 2}: no date or exercise`);
    const order = (r["set order"] ?? "").toLowerCase();
    const set: ParsedSet = {
      ...emptySet(),
      weightKg: toKg(num(r["weight"]), units),
      reps: num(r["reps"]) != null ? Math.round(num(r["reps"])!) : null,
      rpe: num(r["rpe"]),
      durationSeconds: num(r["seconds"]) != null && num(r["seconds"])! > 0 ? Math.round(num(r["seconds"])!) : null,
      isWarmup: order === "w",
    };
    const c = clean(set);
    if (!hasData(c)) return;
    const name = r["workout name"] || "Imported workout";
    b.add(`${when.toISOString()}|${name}`, { name, startedAt: when, durationSeconds: parseDuration(r["duration"]) ?? 0 }, exercise, c);
  });
  return { format: "strong", workouts: b.done(), warnings, unitInFile: null };
}

// ── Hevy ────────────────────────────────────────────────────────────────────
// title, start_time, end_time, description, exercise_title, superset_id, exercise_notes, set_index,
// set_type, weight_kg | weight_lbs, reps, distance_km | distance_miles, duration_seconds, rpe
function parseHevy(text: string, units: WeightUnit): ParseResult {
  const { headers, rows } = table(text);
  const lbs = headers.includes("weight lbs") && !headers.includes("weight kg");
  const unitInFile: WeightUnit = lbs ? "lb" : "kg";
  const miles = headers.includes("distance miles") && !headers.includes("distance km");
  const b = new WorkoutBuilder();
  const warnings: string[] = [];
  rows.forEach((r, i) => {
    const start = parseWhen(r["start time"]);
    const exercise = r["exercise title"];
    if (!start || !exercise) return void warnings.push(`Row ${i + 2}: no start time or exercise`);
    const end = parseWhen(r["end time"] ?? "");
    const distance = num(r["distance km"] ?? r["distance miles"]);
    const set: ParsedSet = {
      ...emptySet(),
      weightKg: toKg(num(r["weight kg"] ?? r["weight lbs"]), lbs ? "lb" : "kg"),
      reps: num(r["reps"]) != null ? Math.round(num(r["reps"])!) : null,
      rpe: num(r["rpe"]),
      durationSeconds: num(r["duration seconds"]) != null && num(r["duration seconds"])! > 0 ? Math.round(num(r["duration seconds"])!) : null,
      distanceM: distance != null && distance > 0 ? Math.round(distance * (miles ? 1609.344 : 1000)) : null,
      isWarmup: (r["set type"] ?? "").toLowerCase() === "warmup",
    };
    const c = clean(set);
    if (!hasData(c)) return;
    const name = r["title"] || "Imported workout";
    b.add(`${start.toISOString()}|${name}`, { name, startedAt: start, durationSeconds: end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000)) : 0 }, exercise, c);
  });
  void units; // Hevy states its unit in the column name, so the caller's choice is not needed
  return { format: "hevy", workouts: b.done(), warnings, unitInFile };
}

// ── FitNotes ────────────────────────────────────────────────────────────────
// Date, Exercise, Category, Weight (kgs|lbs), Reps, Distance, Distance Unit, Time
// One row per set, no workout grouping: each day becomes one workout.
function parseFitNotes(text: string, units: WeightUnit): ParseResult {
  const { headers, rows } = table(text);
  const wKey = headers.find((h) => h.startsWith("weight")) ?? "weight";
  const unitInFile: WeightUnit | null = wKey.includes("lb") ? "lb" : wKey.includes("kg") ? "kg" : null;
  const unit = unitInFile ?? units;
  const b = new WorkoutBuilder();
  const warnings: string[] = [];
  rows.forEach((r, i) => {
    const when = parseWhen(r["date"]);
    const exercise = r["exercise"];
    if (!when || !exercise) return void warnings.push(`Row ${i + 2}: no date or exercise`);
    const dist = num(r["distance"]);
    const du = (r["distance unit"] ?? "m").toLowerCase();
    const set: ParsedSet = {
      ...emptySet(),
      weightKg: toKg(num(r[wKey]), unit),
      reps: num(r["reps"]) != null ? Math.round(num(r["reps"])!) : null,
      durationSeconds: parseDuration(r["time"]),
      distanceM: dist != null && dist > 0 ? Math.round(dist * (DISTANCE_TO_M[du] ?? 1)) : null,
    };
    const c = clean(set);
    if (!hasData(c)) return;
    const day = when.toISOString().slice(0, 10);
    b.add(day, { name: "FitNotes workout", startedAt: new Date(`${day}T12:00:00Z`), durationSeconds: 0 }, exercise, c);
  });
  return { format: "fitnotes", workouts: b.done(), warnings, unitInFile };
}

export function parseWorkoutCsv(text: string, format: ImportFormat | "auto" = "auto", units: WeightUnit = "kg"): ParseResult {
  const fmt = format === "auto" ? detectFormat(text) : format;
  if (!fmt) throw new Error("This doesn't look like a Strong, Hevy or FitNotes export");
  return fmt === "strong" ? parseStrong(text, units) : fmt === "hevy" ? parseHevy(text, units) : parseFitNotes(text, units);
}

// ── matching names to the exercise library ──────────────────────────────────

export const normalizeName = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** "Bench Press (Barbell)" → ["barbell bench press", "bench press"]. */
export function nameVariants(raw: string): string[] {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw.trim());
  const out = [normalizeName(raw)];
  if (m) out.unshift(normalizeName(`${m[2]} ${m[1]}`), normalizeName(m[1]));
  return [...new Set(out.filter(Boolean))];
}

export interface CatalogEntry {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * Match an exported exercise name to a library entry. Exact (name or alias) first; then a
 * name that contains every word of the exported one, only if exactly one entry does, so
 * "Barbell Squat" never silently becomes "Barbell Front Squat". Otherwise null.
 */
export function matchExercise(raw: string, catalog: CatalogEntry[]): CatalogEntry | null {
  const variants = nameVariants(raw);
  const exact = new Map<string, CatalogEntry>();
  for (const e of catalog) {
    exact.set(normalizeName(e.name), e);
    for (const a of e.aliases) if (!exact.has(normalizeName(a))) exact.set(normalizeName(a), e);
  }
  for (const v of variants) {
    const hit = exact.get(v);
    if (hit) return hit;
  }
  for (const v of variants) {
    const words = v.split(" ");
    if (words.length < 2) continue;
    const hits = catalog.filter((e) => {
      const tokens = new Set(normalizeName(e.name).split(" "));
      return words.every((w) => tokens.has(w));
    });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// ── Apple Health body weight ────────────────────────────────────────────────

export interface WeightReading {
  recordedAt: Date;
  weightKg: number;
}

/** Body mass records from an Apple Health export.xml (text). Other record types are ignored. */
export function parseHealthWeights(xml: string): WeightReading[] {
  const out: WeightReading[] = [];
  const re = /<Record\b[^>]*type="HKQuantityTypeIdentifierBodyMass"[^>]*>/g;
  for (const tag of xml.match(re) ?? []) {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(tag)?.[1];
    const value = num(attr("value"));
    const when = attr("startDate") ?? attr("creationDate");
    if (value == null || value <= 0 || !when) continue;
    const unit = (attr("unit") ?? "kg").toLowerCase();
    const kg = unit === "lb" ? value * LB_TO_KG : unit === "g" ? value / 1000 : value;
    // "2023-01-15 08:00:00 -0700" → ISO with an offset
    const iso = when.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/, (_m, d, t, z) => `${d}T${t}${z.slice(0, 3)}:${z.slice(3)}`);
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()) || kg < 20 || kg > 400) continue;
    out.push({ recordedAt: at, weightKg: round2(kg) });
  }
  return out.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}
