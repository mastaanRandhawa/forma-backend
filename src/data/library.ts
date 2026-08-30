/** Muscle groups + exercise library seed — ported/expanded from the specs and
 *  frontend/src/lib/data.ts (`exercises`, `muscleActivation`, `rankedMuscles`). */

export const EQUIPMENT = [
  { key: "barbell", name: "Barbell" },
  { key: "dumbbell", name: "Dumbbell" },
  { key: "cable", name: "Cable" },
  { key: "machine", name: "Machine" },
  { key: "bodyweight", name: "Bodyweight" },
  { key: "kettlebell", name: "Kettlebell" },
  { key: "bands", name: "Resistance bands" },
];

export const MUSCLE_GROUPS = [
  { key: "chest", name: "Pectoralis major", plainName: "Chest", region: "upper" },
  { key: "shoulders", name: "Deltoids", plainName: "Shoulders", region: "upper" },
  { key: "rear_delts", name: "Posterior deltoid", plainName: "Rear delts", region: "upper" },
  { key: "triceps", name: "Triceps brachii", plainName: "Triceps", region: "upper" },
  { key: "biceps", name: "Biceps brachii", plainName: "Biceps", region: "upper" },
  { key: "forearms", name: "Forearm flexors", plainName: "Forearms", region: "upper" },
  { key: "back", name: "Erector spinae / mid-back", plainName: "Back", region: "upper" },
  { key: "lats", name: "Latissimus dorsi", plainName: "Lats", region: "upper" },
  { key: "traps", name: "Trapezius", plainName: "Traps", region: "upper" },
  { key: "abs", name: "Rectus abdominis", plainName: "Abs", region: "core" },
  { key: "obliques", name: "Obliques", plainName: "Obliques", region: "core" },
  { key: "glutes", name: "Gluteus maximus", plainName: "Glutes", region: "lower" },
  { key: "quads", name: "Quadriceps", plainName: "Quads", region: "lower" },
  { key: "hamstrings", name: "Hamstrings", plainName: "Hamstrings", region: "lower" },
  { key: "calves", name: "Gastrocnemius / soleus", plainName: "Calves", region: "lower" },
  { key: "adductors", name: "Hip adductors", plainName: "Adductors", region: "lower" },
] as const;

type Ex = {
  slug: string;
  name: string;
  category: string;
  movementPattern?: string;
  equipment: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  camera: boolean;
  primary: string[];
  secondary?: string[];
  alternatives?: string[];
};

export const EXERCISES: Ex[] = [
  { slug: "barbell-bench-press", name: "Barbell Bench Press", category: "push", movementPattern: "horizontal_press",
    equipment: ["barbell"], difficulty: "intermediate", camera: true,
    primary: ["chest"], secondary: ["triceps", "shoulders"], alternatives: ["incline-dumbbell-press", "cable-fly"] },
  { slug: "incline-dumbbell-press", name: "Incline Dumbbell Press", category: "push", movementPattern: "incline_press",
    equipment: ["dumbbell"], difficulty: "intermediate", camera: true, primary: ["chest"], secondary: ["shoulders", "triceps"] },
  { slug: "cable-fly", name: "Cable Fly", category: "push", movementPattern: "fly",
    equipment: ["cable"], difficulty: "beginner", camera: false, primary: ["chest"], secondary: ["shoulders"] },
  { slug: "overhead-press", name: "Overhead Press", category: "push", movementPattern: "vertical_press",
    equipment: ["barbell"], difficulty: "intermediate", camera: true, primary: ["shoulders"], secondary: ["triceps", "traps"] },
  { slug: "lateral-raise", name: "Lateral Raise", category: "push", movementPattern: "raise",
    equipment: ["dumbbell"], difficulty: "beginner", camera: false, primary: ["shoulders"] },
  { slug: "triceps-rope-pushdown", name: "Triceps Rope Pushdown", category: "push", movementPattern: "extension",
    equipment: ["cable"], difficulty: "beginner", camera: false, primary: ["triceps"] },
  { slug: "back-squat", name: "Back Squat", category: "legs", movementPattern: "squat",
    equipment: ["barbell"], difficulty: "intermediate", camera: true, primary: ["quads", "glutes"], secondary: ["hamstrings", "abs"],
    alternatives: ["goblet-squat"] },
  { slug: "goblet-squat", name: "Goblet Squat", category: "legs", movementPattern: "squat",
    equipment: ["dumbbell", "kettlebell"], difficulty: "beginner", camera: true, primary: ["quads", "glutes"], secondary: ["abs"] },
  { slug: "conventional-deadlift", name: "Conventional Deadlift", category: "pull", movementPattern: "hinge",
    equipment: ["barbell"], difficulty: "advanced", camera: true, primary: ["back", "glutes", "hamstrings"], secondary: ["traps", "forearms"] },
  { slug: "romanian-deadlift", name: "Romanian Deadlift", category: "pull", movementPattern: "hinge",
    equipment: ["barbell"], difficulty: "intermediate", camera: true, primary: ["hamstrings", "glutes"], secondary: ["back"] },
  { slug: "pull-up", name: "Pull-up", category: "pull", movementPattern: "vertical_pull",
    equipment: ["bodyweight"], difficulty: "intermediate", camera: true, primary: ["lats"], secondary: ["biceps", "rear_delts"] },
  { slug: "dumbbell-row", name: "Dumbbell Row", category: "pull", movementPattern: "horizontal_pull",
    equipment: ["dumbbell"], difficulty: "beginner", camera: true, primary: ["back", "lats"], secondary: ["biceps", "rear_delts"] },
  { slug: "bicep-curl", name: "Bicep Curl", category: "pull", movementPattern: "curl",
    equipment: ["dumbbell"], difficulty: "beginner", camera: false, primary: ["biceps"], secondary: ["forearms"] },
  { slug: "plank", name: "Plank", category: "core", movementPattern: "anti_extension",
    equipment: ["bodyweight"], difficulty: "beginner", camera: true, primary: ["abs"], secondary: ["obliques"] },
];
