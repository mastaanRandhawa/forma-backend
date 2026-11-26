/**
 * free-exercise-db (github.com/yuhonas/free-exercise-db) import helpers.
 *
 * Public domain (Unlicense): ~870 exercises with muscles, equipment, level,
 * instructions and two photos each. We fold it into our own vocabularies and
 * only ADD exercises we don't already have; nothing existing is overwritten.
 * Pure functions, unit-tested in free-exercise-db.test.ts, used by
 * scripts/import-free-exercise-db.ts.
 */
import { mapDifficulty } from "./repdb.js";

export const FED_SOURCE = "free-exercise-db" as const;
export const FED_JSON_URL = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
export const FED_IMAGE_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

export interface FedExercise {
  id: string;
  name: string;
  force?: string | null; // push | pull | static
  level?: string | null; // beginner | intermediate | expert
  mechanic?: string | null; // compound | isolation
  equipment?: string | null;
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  instructions?: string[];
  category?: string | null; // strength | stretching | plyometrics | powerlifting | olympic weightlifting | strongman | cardio
  images?: string[];
}

const MUSCLE_MAP: Record<string, string> = {
  abdominals: "abs",
  chest: "chest",
  shoulders: "shoulders",
  quadriceps: "quads",
  hamstrings: "hamstrings",
  triceps: "triceps",
  biceps: "biceps",
  lats: "lats",
  "middle back": "back",
  "lower back": "back",
  calves: "calves",
  forearms: "forearms",
  glutes: "glutes",
  traps: "traps",
  adductors: "adductors",
  abductors: "glutes",
  neck: "traps",
};

export const mapFedMuscle = (m: string): string | null => MUSCLE_MAP[m.toLowerCase()] ?? null;

const EQUIPMENT_MAP: Record<string, string> = {
  "body only": "bodyweight",
  barbell: "barbell",
  dumbbell: "dumbbell",
  cable: "cable",
  machine: "machine",
  kettlebells: "kettlebell",
  bands: "bands",
  "e-z curl bar": "barbell",
  "medicine ball": "bodyweight",
  "exercise ball": "bodyweight",
  "foam roll": "bodyweight",
};

export function mapFedEquipment(raw: string | null | undefined): string[] {
  if (!raw) return ["bodyweight"];
  return [EQUIPMENT_MAP[raw.toLowerCase()] ?? "other"];
}

const dedupe = <T>(a: T[]) => [...new Set(a)];
const BODY_PART: Record<string, string> = {
  chest: "chest", lats: "back", "middle back": "back", "lower back": "back", traps: "back", neck: "neck",
  shoulders: "shoulders", biceps: "upper_arms", triceps: "upper_arms", forearms: "lower_arms",
  abdominals: "core", quadriceps: "upper_legs", hamstrings: "upper_legs", glutes: "upper_legs",
  adductors: "upper_legs", abductors: "upper_legs", calves: "lower_legs",
};

/** the app's training-split bucket */
export function fedCategory(ex: FedExercise): string {
  const lead = ex.primaryMuscles?.[0]?.toLowerCase() ?? "";
  if (ex.category === "stretching") return "mobility";
  if (ex.category === "cardio") return "conditioning";
  if (ex.category === "olympic weightlifting") return "olympic";
  if (lead === "abdominals") return "core";
  if (["quadriceps", "hamstrings", "calves", "glutes", "adductors", "abductors"].includes(lead)) return "legs";
  if (ex.force === "push") return "push";
  if (ex.force === "pull") return "pull";
  return "accessory";
}

export const fedDifficulty = (level: string | null | undefined) => mapDifficulty(level === "expert" ? "advanced" : (level ?? undefined));

export const fedImage = (path: string | undefined): string | null =>
  path ? FED_IMAGE_BASE + path.split("/").map(encodeURIComponent).join("/") : null;

export interface NormalizedFed {
  externalId: string;
  slug: string;
  name: string;
  category: string;
  equipment: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  instructions: string[];
  bodyPart: string | null;
  forceType: string | null;
  mechanic: string | null;
  discipline: string | null;
  isBodyweight: boolean;
  trackingType: "reps" | "time" | "cardio";
  imageStartUrl: string | null;
  imageEndUrl: string | null;
  primary: string[];
  secondary: string[];
}

export function normalizeFed(ex: FedExercise): NormalizedFed {
  const primary = dedupe((ex.primaryMuscles ?? []).map(mapFedMuscle).filter(Boolean) as string[]);
  const secondary = dedupe(((ex.secondaryMuscles ?? []).map(mapFedMuscle).filter(Boolean) as string[]).filter((m) => !primary.includes(m)));
  const equipment = mapFedEquipment(ex.equipment);
  const [first, second] = ex.images ?? [];
  const start = fedImage(first);
  const discipline = ex.category === "olympic weightlifting" ? "olympic" : ex.category === "powerlifting" || ex.category === "strongman" ? "strength" : (ex.category ?? null);
  return {
    externalId: `fed:${ex.id}`,
    slug: `fed-${ex.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    name: ex.name.trim(),
    category: fedCategory(ex),
    equipment,
    difficulty: fedDifficulty(ex.level),
    instructions: (ex.instructions ?? []).map((s) => s.trim()).filter(Boolean),
    bodyPart: BODY_PART[ex.primaryMuscles?.[0]?.toLowerCase() ?? ""] ?? null,
    forceType: ex.force ?? null,
    mechanic: ex.mechanic ?? null,
    discipline,
    isBodyweight: equipment.includes("bodyweight"),
    trackingType: ex.category === "cardio" ? "cardio" : ex.force === "static" ? "time" : "reps",
    imageStartUrl: start,
    imageEndUrl: fedImage(second) ?? start,
    primary,
    secondary,
  };
}

const STOP = new Set(["the", "a", "with", "and", "to", "on", "of"]);
/** "pull up", "pull-up", "pullups" all become one word before comparing */
const JOINED = [[/\b(pull|push|sit|chin|step|press) ups?\b/g, "$1up"], [/\b(pull|push|sit|chin|step)ups\b/g, "$1up"]] as const;

/**
 * Duplicate key: order-insensitive, ignores plurals, hyphens and filler words, so
 * "Triceps Pushdown", "Tricep push-down" and "Pushdown, Triceps" collapse to one.
 */
export function dupKey(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const [re, to] of JOINED) s = s.replace(re, to);
  const t = s
    .split(" ")
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w === "triceps" ? "tricep" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .map((w) => (w === "battling" ? "battle" : w === "pushdown" || w === "push-down" ? "pushdown" : w));
  return [...new Set(t)].sort().join(" ");
}

/** Name keys already taken, from every existing exercise name and alias. */
export function takenKeys(existing: { name: string; aliases?: string[] }[]): Set<string> {
  const keys = new Set<string>();
  for (const e of existing) for (const n of [e.name, ...(e.aliases ?? [])]) keys.add(dupKey(n));
  return keys;
}

/** Records we should add: not already present by name/alias, with at least one muscle, no repeats inside the file. */
export function selectNew(records: FedExercise[], taken: Set<string>): { add: NormalizedFed[]; duplicates: string[]; noMuscle: string[] } {
  const seen = new Set(taken);
  const add: NormalizedFed[] = [];
  const duplicates: string[] = [];
  const noMuscle: string[] = [];
  for (const r of records) {
    const key = dupKey(r.name);
    if (seen.has(key)) { duplicates.push(r.name); continue; }
    const n = normalizeFed(r);
    if (!n.primary.length) { noMuscle.push(r.name); continue; }
    seen.add(key);
    add.push(n);
  }
  return { add, duplicates, noMuscle };
}
