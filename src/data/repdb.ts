/**
 * RepDB (repdb.co) free-tier integration — taxonomy mappings + record
 * normalization.
 *
 * RepDB ships its own muscle / equipment / classification vocabularies. This
 * module folds them into the app's existing vocabularies (the 16 `MuscleGroup`
 * keys and 7 `Equipment` keys seeded in `library.ts`) so imported exercises
 * filter and render exactly like the hand-curated ones. Pure functions only —
 * unit-tested in `repdb.test.ts`, consumed by `scripts/import-repdb.ts`.
 *
 * Licensing: free-tier, commercial in-app use permitted, visible attribution
 * required ("Exercise data by RepDB — repdb.co"). No redistribution as a
 * dataset: we import into our own data model, we do not re-publish the files.
 */

export const REPDB_SOURCE = "repdb" as const;
export const REPDB_JSON_URL = "https://exercise-dataset.com/exercises.json";
export const REPDB_IMAGE_BASE = "https://exercise-dataset.com/images/flat/";
export const REPDB_ATTRIBUTION = "Exercise data by RepDB — repdb.co";

// ── RepDB raw record shape (schema_version 3, EN locale only) ────────────────
export interface RepDbExercise {
  id: string;
  name_en: string;
  description_en?: string;
  instructions_en?: string[];
  tips_en?: string[];
  category?: string; // strength | stretching | cardio | olympic | plyometrics
  force_type?: string; // push | pull | static | dynamic
  mechanic?: string; // compound | isolation
  difficulty?: string; // beginner | intermediate | advanced
  equipment?: string; // snake_case, absent for bodyweight-only moves
  body_part?: string;
  primary_muscles?: string[];
  secondary_muscles?: string[];
  goals?: string[];
  tags?: string[];
  met?: number;
  is_unilateral?: boolean;
  is_bodyweight?: boolean;
  images?: { flat?: { start?: string; peak?: string; main?: string } };
}

// ── muscle taxonomy: RepDB anatomical slug → app MuscleGroup key ────────────
const MUSCLE_MAP: Record<string, string> = {
  pectoralis_major: "chest",
  anterior_deltoid: "shoulders",
  lateral_deltoid: "shoulders",
  supraspinatus: "shoulders",
  posterior_deltoid: "rear_delts",
  triceps_brachii: "triceps",
  biceps_brachii: "biceps",
  brachialis: "biceps",
  brachioradialis: "forearms",
  forearm_flexors: "forearms",
  forearm_extensors: "forearms",
  forearms: "forearms",
  latissimus_dorsi: "lats",
  trapezius: "traps",
  rhomboids: "back",
  erector_spinae: "back",
  quadratus_lumborum: "back",
  rectus_abdominis: "abs",
  transverse_abdominis: "abs",
  obliques: "obliques",
  serratus_anterior: "obliques",
  hip_flexors: "abs",
  gluteus_maximus: "glutes",
  gluteus_medius: "glutes",
  abductors: "glutes",
  quadriceps: "quads",
  hamstrings: "hamstrings",
  gastrocnemius: "calves",
  soleus: "calves",
  adductors: "adductors",
};

export function mapMuscle(slug: string): string | null {
  return MUSCLE_MAP[slug] ?? null;
}

// ── equipment: RepDB slug → app Equipment key ──────────────────────────────
const EQUIPMENT_MAP: Record<string, string> = {
  barbell: "barbell",
  ez_bar: "barbell",
  trap_bar: "barbell",
  plates: "barbell",
  dumbbell: "dumbbell",
  kettlebell: "kettlebell",
  cable: "cable",
  loop_band: "bands",
  resistance_band: "bands",
  battle_rope: "bands",
  pull_up_bar: "bodyweight",
  dip_station: "bodyweight",
  rings: "bodyweight",
  suspension_trainer: "bodyweight",
  stability_ball: "bodyweight",
  plyo_box: "bodyweight",
  jump_rope: "bodyweight",
  climbing_rope: "bodyweight",
  slam_ball: "bodyweight",
  ab_wheel: "bodyweight",
  flat_bench: "bodyweight",
};

/** Any `*_machine` / named-machine slug collapses to "machine"; unknown → raw. */
export function mapEquipment(raw: string | undefined | null): string[] {
  if (!raw) return ["bodyweight"];
  if (EQUIPMENT_MAP[raw]) return [EQUIPMENT_MAP[raw]];
  if (
    raw.endsWith("_machine") ||
    ["leg_press", "leg_curl", "leg_extension", "hack_squat", "smith_machine", "pec_deck", "glute_ham_developer"].includes(raw)
  )
    return ["machine"];
  if (["treadmill", "elliptical", "rower", "stationary_bike", "air_bike", "stair_climber"].includes(raw)) return ["machine"];
  return [raw];
}

// ── app `category` (a training-split bucket) derived from RepDB signals ─────
export function deriveCategory(ex: RepDbExercise): string {
  const bp = ex.body_part ?? "";
  if (ex.category === "stretching") return "mobility";
  if (ex.category === "cardio") return "conditioning";
  if (ex.category === "olympic") return "olympic";
  if (bp === "core") return "core";
  if (["upper_legs", "lower_legs"].includes(bp)) return "legs";
  if (ex.force_type === "push") return "push";
  if (ex.force_type === "pull") return "pull";
  if (bp === "full_body") return "full_body";
  return "accessory";
}

const DIFFICULTY = new Set(["beginner", "intermediate", "advanced"]);
export function mapDifficulty(d: string | undefined): "beginner" | "intermediate" | "advanced" {
  return d && DIFFICULTY.has(d) ? (d as "beginner" | "intermediate" | "advanced") : "intermediate";
}

export function imageUrl(path: string | undefined): string | null {
  if (!path) return null;
  // records carry a repo-relative path ("images/flat/<id>-peak.webp")
  const file = path.replace(/^.*images\/flat\//, "");
  return REPDB_IMAGE_BASE + file;
}

/** Movement patterns cameras can score — carried over from the native seed. */
const CAMERA_PATTERNS = new Set([
  "squat", "hinge", "horizontal_press", "vertical_press", "incline_press",
  "horizontal_pull", "vertical_pull", "anti_extension", "lunge",
]);

export interface NormalizedExercise {
  externalId: string;
  slug: string;
  name: string;
  category: string;
  equipment: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  instructions: string[];
  description: string | null;
  formTips: string[];
  bodyPart: string | null;
  forceType: string | null;
  mechanic: string | null;
  discipline: string | null;
  isUnilateral: boolean | null;
  isBodyweight: boolean | null;
  metValue: number | null;
  trainingGoals: string[];
  imageStartUrl: string | null;
  imageEndUrl: string | null;
  supportsCameraTracking: boolean;
  primary: string[]; // mapped MuscleGroup keys
  secondary: string[];
}

export function normalize(ex: RepDbExercise): NormalizedExercise {
  const flat = ex.images?.flat ?? {};
  const start = imageUrl(flat.start ?? flat.main);
  const end = imageUrl(flat.peak) ?? (flat.main ? start : null);
  const primary = dedupe((ex.primary_muscles ?? []).map(mapMuscle).filter(Boolean) as string[]);
  const secondary = dedupe(
    ((ex.secondary_muscles ?? []).map(mapMuscle).filter(Boolean) as string[]).filter((m) => !primary.includes(m)),
  );
  const mechanic = ex.mechanic ?? null;
  return {
    externalId: ex.id,
    slug: ex.id,
    name: ex.name_en,
    category: deriveCategory(ex),
    equipment: mapEquipment(ex.equipment),
    difficulty: mapDifficulty(ex.difficulty),
    instructions: (ex.instructions_en ?? []).filter(Boolean),
    description: ex.description_en?.trim() || null,
    formTips: (ex.tips_en ?? []).filter(Boolean),
    bodyPart: ex.body_part ?? null,
    forceType: ex.force_type ?? null,
    mechanic,
    discipline: ex.category ?? null,
    isUnilateral: ex.is_unilateral ?? null,
    isBodyweight: ex.is_bodyweight ?? null,
    metValue: typeof ex.met === "number" ? ex.met : null,
    trainingGoals: ex.goals ?? [],
    imageStartUrl: start,
    imageEndUrl: end && end !== start ? end : null,
    supportsCameraTracking: false, // opt-in per exercise; RepDB has no camera metadata
    primary,
    secondary,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Normalized-name key for matching RepDB records to hand-curated exercises. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|with|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

void CAMERA_PATTERNS;
