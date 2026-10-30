import { describe, expect, it } from "vitest";
import { buildExportCsv, csvText } from "./exportCsv.js";

describe("csvText", () => {
  it("quotes and doubles inner quotes", () => {
    expect(csvText('Mom\'s "power" oats')).toBe('"Mom\'s ""power"" oats"');
  });
  it("neutralises leading formula characters", () => {
    expect(csvText("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvText("-1")).toBe(`"'-1"`);
    expect(csvText("Leg Day")).toBe('"Leg Day"');
  });
});

describe("buildExportCsv", () => {
  const csv = buildExportCsv(
    [
      {
        name: 'Push "A"',
        startedAt: new Date("2026-10-27T07:30:00Z"),
        performances: [
          {
            exercise: { name: "Bench Press" },
            sets: [
              { weightKg: 40, reps: 10, rpe: null, isWarmup: true },
              { weightKg: 80, reps: 5, rpe: 8, isWarmup: false },
              { weightKg: null, reps: null, rpe: null, isWarmup: false },
            ],
          },
        ],
      },
    ],
    [
      {
        loggedAt: new Date("2026-10-27T12:00:00Z"),
        mealType: "lunch",
        foodName: "Chicken, rice",
        brand: null,
        calories: 650,
        protein: 45,
        carbs: 70,
        fat: 15.5,
        quantity: 1,
        servingUnit: "serving",
      },
    ],
  );
  const lines = csv.split("\n");

  it("writes one row per set, numbering working sets only", () => {
    expect(lines[2]).toBe('2026-10-27,"Push ""A""","Bench Press",0,40,10,,1,53');
    expect(lines[3]).toBe('2026-10-27,"Push ""A""","Bench Press",1,80,5,8,0,93');
    expect(lines[4]).toBe('2026-10-27,"Push ""A""","Bench Press",2,,,,0,');
  });

  it("keeps commas inside quoted food names", () => {
    expect(lines).toContain('2026-10-27,lunch,"Chicken, rice","",650,45,70,15.5,1,"serving"');
  });
});
