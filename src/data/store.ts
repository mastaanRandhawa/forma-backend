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
  // ── first times ────────────────────────────────────────────────────────────
  { key: "first-session",     title: "Day one",             detail: "Complete your first workout",                      icon: "star" },
  { key: "first-pr",          title: "On the board",        detail: "Set your first personal record",                   icon: "trophy" },
  { key: "first-superset",    title: "Two at once",         detail: "Complete a superset",                              icon: "zap" },
  { key: "first-barcode",     title: "Scan it",             detail: "Log a food using the barcode scanner",             icon: "scan" },
  { key: "first-program",     title: "Committed",           detail: "Start a multi-week program",                       icon: "map" },
  { key: "first-deload",      title: "Smart recovery",      detail: "Complete a deload week",                           icon: "activity" },
  { key: "first-wearable",    title: "Wired up",            detail: "Connect a wearable device",                        icon: "watch" },

  // ── streaks ────────────────────────────────────────────────────────────────
  { key: "streak-3",   title: "Hat trick",         detail: "Train 3 days in a row",   icon: "flame", targetValue: 3   },
  { key: "streak-7",   title: "One full week",     detail: "Train 7 days in a row",   icon: "flame", targetValue: 7   },
  { key: "streak-14",  title: "Two weeks straight",detail: "Train 14 days in a row",  icon: "flame", targetValue: 14  },
  { key: "streak-30",  title: "A month of iron",   detail: "Train 30 days in a row",  icon: "flame", targetValue: 30  },
  { key: "streak-60",  title: "Two month warrior", detail: "Train 60 days in a row",  icon: "flame", targetValue: 60  },
  { key: "streak-90",  title: "Quarter-year grind",detail: "Train 90 days in a row",  icon: "flame", targetValue: 90  },

  // ── session count ──────────────────────────────────────────────────────────
  { key: "sessions-10",   title: "Getting started",   detail: "Complete 10 workouts",   icon: "dumbbell", targetValue: 10  },
  { key: "sessions-25",   title: "Quarter century",   detail: "Complete 25 workouts",   icon: "dumbbell", targetValue: 25  },
  { key: "sessions-50",   title: "Fifty sessions",    detail: "Complete 50 workouts",   icon: "dumbbell", targetValue: 50  },
  { key: "sessions-100",  title: "Century club",      detail: "Complete 100 workouts",  icon: "dumbbell", targetValue: 100 },
  { key: "sessions-250",  title: "Dedicated",         detail: "Complete 250 workouts",  icon: "dumbbell", targetValue: 250 },

  // ── volume milestones (kg) ─────────────────────────────────────────────────
  { key: "volume-10k",   title: "10,000 kg moved",     detail: "Lift 10,000 kg all-time",      icon: "weight",    targetValue: 10_000   },
  { key: "volume-50k",   title: "50,000 kg moved",     detail: "Lift 50,000 kg all-time",      icon: "weight",    targetValue: 50_000   },
  { key: "volume-100k",  title: "100,000 kg moved",    detail: "Lift 100,000 kg all-time",     icon: "weight",    targetValue: 100_000  },
  { key: "volume-500k",  title: "500,000 kg moved",    detail: "Lift 500,000 kg all-time",     icon: "weight",    targetValue: 500_000  },
  { key: "volume-1m",    title: "One million kilos",   detail: "Lift 1,000,000 kg all-time",   icon: "weight",    targetValue: 1_000_000 },

  // ── PRs by lift ────────────────────────────────────────────────────────────
  { key: "pr-bench",    title: "Bench PR",    detail: "Set a personal record on bench press",  icon: "trophy" },
  { key: "pr-squat",    title: "Squat PR",    detail: "Set a personal record on squat",        icon: "trophy" },
  { key: "pr-deadlift", title: "Deadlift PR", detail: "Set a personal record on deadlift",     icon: "trophy" },
  { key: "pr-ohp",      title: "Overhead PR", detail: "Set a personal record on overhead press", icon: "trophy" },
  { key: "pr-row",      title: "Row PR",      detail: "Set a personal record on barbell row",  icon: "trophy" },

  // ── PR count ───────────────────────────────────────────────────────────────
  { key: "prs-5",    title: "Record setter",     detail: "Set 5 personal records",   icon: "trophy", targetValue: 5  },
  { key: "prs-10",   title: "PR machine",        detail: "Set 10 personal records",  icon: "trophy", targetValue: 10 },
  { key: "prs-25",   title: "Always improving",  detail: "Set 25 personal records",  icon: "trophy", targetValue: 25 },
  { key: "prs-50",   title: "Living legend",     detail: "Set 50 personal records",  icon: "trophy", targetValue: 50 },

  // ── nutrition ─────────────────────────────────────────────────────────────
  { key: "protein-goal-7",   title: "Protein week",       detail: "Hit your protein goal 7 days in a row",  icon: "utensils", targetValue: 7  },
  { key: "food-log-30",      title: "Tracking everything", detail: "Log food for 30 days",                  icon: "utensils", targetValue: 30 },

  // ── consistency / calendar ────────────────────────────────────────────────
  { key: "active-days-30",   title: "30 active days",      detail: "Train on 30 different calendar days",  icon: "calendar", targetValue: 30  },
  { key: "active-days-100",  title: "100 active days",     detail: "Train on 100 different calendar days", icon: "calendar", targetValue: 100 },
  { key: "perfect-week",     title: "Perfect week",         detail: "Hit all planned sessions in a week",   icon: "calendar" },
  { key: "perfect-month",    title: "Perfect month",        detail: "Hit all planned sessions in a month",  icon: "calendar" },

  // ── readiness / recovery ──────────────────────────────────────────────────
  { key: "readiness-90",  title: "Fully charged",   detail: "Achieve a readiness score of 90+",      icon: "activity" },
  { key: "checkin-14",    title: "Check-in streak", detail: "Complete 14 daily recovery check-ins",  icon: "activity", targetValue: 14 },

  // ── goals ─────────────────────────────────────────────────────────────────
  { key: "goals-hit-7",   title: "Consistent goals", detail: "Hit all daily goals 7 days in a row",  icon: "target", targetValue: 7  },
  { key: "goals-hit-30",  title: "Goal machine",     detail: "Hit all daily goals 30 days in a row", icon: "target", targetValue: 30 },

  // ── Kai / trainer ─────────────────────────────────────────────────────────
  { key: "kai-chat-first",  title: "First conversation",   detail: "Send your first message to Kai",        icon: "message-circle" },
  { key: "kai-chat-50",     title: "Talked it out",        detail: "Send 50 messages to Kai",               icon: "message-circle", targetValue: 50 },
  { key: "kai-voice",       title: "Say it out loud",      detail: "Use voice mode with Kai",               icon: "mic" },

  // ── store / coins ─────────────────────────────────────────────────────────
  { key: "coins-100",   title: "First purchase",   detail: "Spend 100 coins in the store",  icon: "coins", targetValue: 100  },
  { key: "coins-1000",  title: "Big spender",      detail: "Spend 1,000 coins in the store",icon: "coins", targetValue: 1000 },

  // ── session duration ──────────────────────────────────────────────────────
  { key: "session-60min",   title: "Hour of work",     detail: "Complete a 60-minute session",    icon: "clock" },
  { key: "session-90min",   title: "Marathon session",  detail: "Complete a 90-minute session",    icon: "clock" },
  { key: "session-early",   title: "Early bird",        detail: "Start a session before 7am",      icon: "sunrise" },
];

export const GOAL_TEMPLATES = [
  { key: "workouts", label: "Weekly workouts", target: 5, unit: "sessions", cadence: "weekly" as const, tone: "pink" },
  { key: "protein", label: "Protein today", target: 165, unit: "g", cadence: "daily" as const, tone: "lime" },
  { key: "steps", label: "Daily steps", target: 10_000, unit: "steps", cadence: "daily" as const, tone: "cyan" },
  { key: "sleep", label: "Sleep", target: 8, unit: "h", cadence: "daily" as const, tone: "violet" },
];
