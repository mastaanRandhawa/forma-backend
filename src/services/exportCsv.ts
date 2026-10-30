/**
 * CSV body for `GET /me/export.csv`: one "## workouts" block (a row per set)
 * and one "## nutrition" block (a row per food log). Pure, so it can be tested
 * without a database.
 */

export interface CsvSession {
  name: string;
  startedAt: Date;
  performances: Array<{
    exercise: { name: string };
    sets: Array<{ weightKg: number | null; reps: number | null; rpe: number | null; isWarmup: boolean }>;
  }>;
}

export interface CsvFoodLog {
  loggedAt: Date;
  mealType: string;
  foodName: string;
  brand: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  quantity: number;
  servingUnit: string;
}

/**
 * Quoted CSV text. Inner quotes are doubled, and a leading = + - @ gets a `'`
 * so spreadsheet apps don't evaluate user-typed names as formulas.
 */
export const csvText = (value: string) => `"${value.replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const day = (d: Date) => d.toISOString().slice(0, 10);

export function buildExportCsv(sessions: CsvSession[], foodLogs: CsvFoodLog[]): string {
  const rows: string[] = [];

  rows.push("## workouts");
  rows.push("session_date,session_name,exercise,set_number,weight_kg,reps,rpe,warmup,estimated_1rm");
  for (const s of sessions) {
    for (const perf of s.performances) {
      let workingSetNum = 0;
      for (const set of perf.sets) {
        if (!set.isWarmup) workingSetNum++;
        const e1rm = set.weightKg && set.reps ? Math.round(set.weightKg * (1 + set.reps / 30)) : null;
        rows.push(
          [
            day(s.startedAt),
            csvText(s.name),
            csvText(perf.exercise.name),
            workingSetNum,
            num(set.weightKg),
            num(set.reps),
            num(set.rpe),
            set.isWarmup ? 1 : 0,
            num(e1rm),
          ].join(","),
        );
      }
    }
  }

  rows.push("");
  rows.push("## nutrition");
  rows.push("date,meal_type,food_name,brand,calories,protein_g,carbs_g,fat_g,quantity,serving_unit");
  for (const entry of foodLogs) {
    rows.push(
      [
        day(entry.loggedAt),
        entry.mealType,
        csvText(entry.foodName),
        csvText(entry.brand ?? ""),
        num(entry.calories),
        num(entry.protein),
        num(entry.carbs),
        num(entry.fat),
        num(entry.quantity),
        csvText(entry.servingUnit),
      ].join(","),
    );
  }

  return rows.join("\n");
}
