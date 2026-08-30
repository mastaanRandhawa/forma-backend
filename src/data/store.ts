import type { Prisma } from "@prisma/client";

/** Trainer-customization catalogue — ported from frontend/src/lib/data.ts `storeItems`. */
export const STORE_ITEMS: Prisma.StoreItemCreateInput[] = [
  // voices
  { id: "v-marcus", category: "voice", name: "Marcus", detail: "warm, measured baritone", price: 0, isDefault: true },
  { id: "v-nova", category: "voice", name: "Nova", detail: "bright, quick, energetic", price: 280 },
  { id: "v-atlas", category: "voice", name: "Atlas", detail: "deep, calm, deliberate", price: 320 },
  { id: "v-sable", category: "voice", name: "Sable", detail: "low, dry, understated", price: 360 },

  // personalities — presets for the coaching sliders
  { id: "p-drill", category: "personality", name: "Drill Sergeant", detail: "blunt, relentless, no excuses", price: 500,
    style: { directness: 0.95, warmth: 0.2, detail: 0.5, intensity: 0.95, humor: 0.15 } },
  { id: "p-zen", category: "personality", name: "The Zen Coach", detail: "patient, encouraging, low-pressure", price: 500,
    style: { directness: 0.4, warmth: 0.9, detail: 0.6, intensity: 0.3, humor: 0.45 } },
  { id: "p-analyst", category: "personality", name: "The Analyst", detail: "numbers-first, precise, thorough", price: 500,
    style: { directness: 0.7, warmth: 0.4, detail: 0.98, intensity: 0.5, humor: 0.2 } },
  { id: "p-hype", category: "personality", name: "Hype Squad", detail: "loud, positive, big energy", price: 500,
    style: { directness: 0.6, warmth: 0.85, detail: 0.4, intensity: 0.8, humor: 0.8 } },

  // looks — Kai's avatar gradient
  { id: "l-signature", category: "look", name: "Signature", detail: "the original pink", price: 0, isDefault: true, swatch: "linear-gradient(135deg,#F06CB0,#7A174F)" },
  { id: "l-aurora", category: "look", name: "Aurora", detail: "pink into cyan", price: 150, swatch: "linear-gradient(135deg,#D51A7A,#4D7CFF,#83E9F4)" },
  { id: "l-ember", category: "look", name: "Ember", detail: "coral and amber", price: 150, swatch: "linear-gradient(135deg,#FF6B4A,#FFB661)" },
  { id: "l-frost", category: "look", name: "Frost", detail: "cool blue-white", price: 150, swatch: "linear-gradient(135deg,#83E9F4,#4D7CFF)" },
  { id: "l-nebula", category: "look", name: "Nebula", detail: "violet and wine", price: 220, swatch: "linear-gradient(135deg,#7F60FF,#7A174F)" },

  // chat themes
  { id: "t-default", category: "theme", name: "Default", detail: "soft frosted bubbles", price: 0, isDefault: true },
  { id: "t-minimal", category: "theme", name: "Minimal", detail: "flat, no borders, tight", price: 100 },
  { id: "t-terminal", category: "theme", name: "Terminal", detail: "mono type, green cursor", price: 120 },

  // premium appearance themes (unlock the matching BackgroundPreset — see src/data/appearance.ts)
  { id: "t-nebula", category: "theme", name: "Nebula", detail: "violet & wine background theme", price: 200 },
  { id: "t-oceanic", category: "theme", name: "Oceanic", detail: "deep teal background theme", price: 240 },
];

export const ACHIEVEMENTS: Prisma.AchievementCreateInput[] = [
  { key: "pr-bench", title: "New bench PR", detail: "Set a personal record on bench press", icon: "trophy" },
  { key: "streak-14", title: "14-day streak", detail: "Train 14 days in a row", icon: "flame", targetValue: 14 },
  { key: "consistency", title: "30 active days", detail: "30 active days in a month", icon: "calendar", targetValue: 30 },
  { key: "volume-1m", title: "1,000,000 lb moved", detail: "Move a million pounds all-time", icon: "dumbbell", targetValue: 1_000_000 },
];

export const GOAL_TEMPLATES = [
  { key: "workouts", label: "Weekly workouts", target: 5, unit: "sessions", cadence: "weekly" as const, tone: "pink" },
  { key: "protein", label: "Protein today", target: 165, unit: "g", cadence: "daily" as const, tone: "lime" },
  { key: "steps", label: "Daily steps", target: 10_000, unit: "steps", cadence: "daily" as const, tone: "cyan" },
  { key: "sleep", label: "Sleep", target: 8, unit: "h", cadence: "daily" as const, tone: "violet" },
];
