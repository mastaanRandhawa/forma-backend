import type { Prisma } from "@prisma/client";

/**
 * Curated background/glass presets. Idempotent-upserted by the seed.
 * Exactly one `isDefault: true`. Premium presets reference a `theme` StoreItem.
 */
export const BACKGROUND_PRESETS: Prisma.BackgroundPresetCreateInput[] = [
  {
    id: "aurora-plum",
    name: "Aurora Plum",
    mode: "gradient",
    gradient: { angle: 160, stops: [{ color: "#241021", at: 0 }, { color: "#170D17", at: 0.55 }, { color: "#0E0910", at: 1 }] },
    backgroundColor: "#170D17",
    backgroundDim: 0,
    glass: { opacity: 0.72, blurPx: 18, tint: "#2A1623" },
    accentColor: null,
    sortOrder: 0,
    isDefault: true,
    minTier: null,
    storeItemId: null,
  },
  {
    id: "midnight",
    name: "Midnight",
    mode: "solid",
    backgroundColor: "#0B0B0F",
    backgroundDim: 0,
    glass: { opacity: 0.7, blurPx: 16, tint: "#161622" },
    accentColor: null,
    sortOrder: 1,
  },
  {
    id: "slate-calm",
    name: "Slate Calm",
    mode: "solid",
    backgroundColor: "#141821",
    backgroundDim: 0,
    glass: { opacity: 0.84, blurPx: 10, tint: "#1D2430" },
    accentColor: "#7FA6C9",
    sortOrder: 2,
  },
  {
    id: "paper-light",
    name: "Paper",
    mode: "solid",
    backgroundColor: "#F4F1EC",
    backgroundDim: 0,
    glass: { opacity: 0.86, blurPx: 14, tint: "#FFFFFF" },
    accentColor: "#B5195F",
    sortOrder: 3,
  },
  {
    id: "nebula",
    name: "Nebula",
    mode: "gradient",
    gradient: { angle: 145, stops: [{ color: "#3A1B57", at: 0 }, { color: "#1E1030", at: 0.6 }, { color: "#120A1F", at: 1 }] },
    backgroundColor: "#1E1030",
    backgroundDim: 0.1,
    glass: { opacity: 0.68, blurPx: 22, tint: "#2C1B4A" },
    accentColor: "#B98CFF",
    sortOrder: 4,
    storeItemId: "t-nebula",
  },
  {
    id: "oceanic",
    name: "Oceanic",
    mode: "gradient",
    gradient: { angle: 170, stops: [{ color: "#0C2C33", at: 0 }, { color: "#0A1E27", at: 0.6 }, { color: "#08131A", at: 1 }] },
    backgroundColor: "#0A1E27",
    backgroundDim: 0.08,
    glass: { opacity: 0.7, blurPx: 20, tint: "#12333B" },
    accentColor: "#4FD6C4",
    sortOrder: 5,
    minTier: "established",
    storeItemId: "t-oceanic",
  },
];

/** Brand-default accent when a preset / user leaves `accentColor` null. */
export const BRAND_ACCENT = "#D51A7A";
