import { prisma } from "../prisma.js";

interface GenerateArgs {
  focus: string[]; // muscle-group keys
  durationMin: number;
  equipmentKeys?: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
}

export interface GeneratedExercise {
  exerciseId: string;
  slug: string;
  name: string;
  sets: number;
  repsMin: number;
  repsMax: number;
  restSec: number;
}

export interface GeneratedPlan {
  name: string;
  estimatedDurationMin: number;
  exercises: GeneratedExercise[];
}

const DIFFICULTY_RANK = { beginner: 0, intermediate: 1, advanced: 2 } as const;

/**
 * Deterministic workout generator (§22.7: keep set/rep selection auditable code,
 * not an LLM decision). ~1 exercise per 8 minutes, compound lifts first, filtered
 * by available equipment and the user's experience ceiling.
 */
export async function generateWorkout(args: GenerateArgs): Promise<GeneratedPlan> {
  const slots = Math.max(3, Math.min(8, Math.round(args.durationMin / 8)));

  const candidates = await prisma.exercise.findMany({
    where: {
      muscles: { some: { role: { in: ["primary", "secondary"] }, muscleGroup: { key: { in: args.focus } } } },
      ...(args.equipmentKeys?.length ? { equipment: { hasSome: args.equipmentKeys } } : {}),
    },
    include: { muscles: { include: { muscleGroup: true } } },
  });

  const ceiling = DIFFICULTY_RANK[args.difficulty];
  const usable = candidates.filter((e) => DIFFICULTY_RANK[e.difficulty] <= ceiling + 1);

  // score: primary hit on a focus muscle + compound bonus
  const scored = usable
    .map((e) => {
      const primaryHits = e.muscles.filter(
        (m) => m.role === "primary" && args.focus.includes(m.muscleGroup.key),
      ).length;
      const compound = e.muscles.filter((m) => m.role === "primary").length > 1 ? 1 : 0;
      return { e, score: primaryHits * 2 + compound };
    })
    .sort((a, b) => b.score - a.score);

  const picked: typeof usable = [];
  const seenPattern = new Set<string>();
  for (const { e } of scored) {
    if (picked.length >= slots) break;
    const pat = e.movementPattern ?? e.slug;
    if (seenPattern.has(pat)) continue;
    seenPattern.add(pat);
    picked.push(e);
  }

  const repRange = args.difficulty === "advanced" ? [5, 8] : args.difficulty === "beginner" ? [10, 15] : [8, 12];

  return {
    name: `${args.focus.map(cap).join(" & ")} Session`,
    estimatedDurationMin: args.durationMin,
    exercises: picked.map((e, i) => ({
      exerciseId: e.id,
      slug: e.slug,
      name: e.name,
      sets: i < 2 ? 4 : 3,
      repsMin: repRange[0]!,
      repsMax: repRange[1]!,
      restSec: i < 2 ? 150 : 90,
    })),
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
