/**
 * Cosmetic-customization catalogue — the server-authoritative price + slot map.
 *
 * Kept in sync with `frontend/src/lib/data.ts` `customizationItems` (which also
 * carries the visual detail the API doesn't need). The frontend renders names /
 * swatches / rarity from its own copy; the backend only needs to know what a
 * purchase costs and which slot it equips into so it can validate a buy and
 * update the equipped map.
 */

export type CustomizationSlot =
  | "theme"
  | "accent"
  | "effect"
  | "avatar"
  | "chatTheme"
  | "frame"
  | "title"
  | "badge";

export interface CatalogueEntry {
  slot: CustomizationSlot;
  price: number;
}

export const CUSTOMIZATION_CATALOGUE: Record<string, CatalogueEntry> = {
  // themes
  "aurora-plum": { slot: "theme", price: 0 },
  midnight: { slot: "theme", price: 0 },
  carbon: { slot: "theme", price: 420 },
  sunset: { slot: "theme", price: 460 },
  forest: { slot: "theme", price: 440 },
  arctic: { slot: "theme", price: 720 },
  synthwave: { slot: "theme", price: 780 },
  sakura: { slot: "theme", price: 700 },
  "gold-vault": { slot: "theme", price: 1600 },
  nebula: { slot: "theme", price: 1500 },
  terminal: { slot: "theme", price: 1400 },

  // accents
  "ac-brand": { slot: "accent", price: 0 },
  "ac-ember": { slot: "accent", price: 90 },
  "ac-cyan": { slot: "accent", price: 90 },
  "ac-lime": { slot: "accent", price: 120 },
  "ac-violet": { slot: "accent", price: 120 },
  "ac-gold": { slot: "accent", price: 200 },
  "ac-mint": { slot: "accent", price: 120 },
  "ac-blood": { slot: "accent", price: 160 },

  // ambient effects
  "fx-auto": { slot: "effect", price: 0 },
  "fx-none": { slot: "effect", price: 0 },
  "fx-glow": { slot: "effect", price: 140 },
  "fx-particles": { slot: "effect", price: 220 },
  "fx-aurora": { slot: "effect", price: 200 },
  "fx-grain": { slot: "effect", price: 160 },
  "fx-scanlines": { slot: "effect", price: 260 },

  // Kai looks
  "l-signature": { slot: "avatar", price: 0 },
  "l-aurora": { slot: "avatar", price: 150 },
  "l-ember": { slot: "avatar", price: 150 },
  "l-frost": { slot: "avatar", price: 150 },
  "l-nebula": { slot: "avatar", price: 220 },
  "l-jade": { slot: "avatar", price: 220 },
  "l-mono": { slot: "avatar", price: 260 },
  "l-gold": { slot: "avatar", price: 600 },
  "l-holo": { slot: "avatar", price: 900 },

  // chat skins
  "t-default": { slot: "chatTheme", price: 0 },
  "t-minimal": { slot: "chatTheme", price: 100 },
  "t-terminal": { slot: "chatTheme", price: 120 },
  "t-paper": { slot: "chatTheme", price: 160 },
  "t-bubblegum": { slot: "chatTheme", price: 160 },
  "t-ink": { slot: "chatTheme", price: 200 },

  // profile — frames
  "fr-none": { slot: "frame", price: 0 },
  "fr-ring": { slot: "frame", price: 120 },
  "fr-laurel": { slot: "frame", price: 300 },
  "fr-flame": { slot: "frame", price: 350 },
  "fr-prism": { slot: "frame", price: 700 },
  "fr-crown": { slot: "frame", price: 1200 },
  // profile — titles
  "ti-none": { slot: "title", price: 0 },
  "ti-earlybird": { slot: "title", price: 150 },
  "ti-ironwilled": { slot: "title", price: 150 },
  "ti-relentless": { slot: "title", price: 250 },
  "ti-machine": { slot: "title", price: 250 },
  "ti-legend": { slot: "title", price: 800 },
  // profile — badges
  "bd-none": { slot: "badge", price: 0 },
  "bd-spark": { slot: "badge", price: 100 },
  "bd-bolt": { slot: "badge", price: 100 },
  "bd-star": { slot: "badge", price: 200 },
  "bd-diamond": { slot: "badge", price: 500 },
};

export const DEFAULT_EQUIPPED: Record<CustomizationSlot, string> = {
  theme: "aurora-plum",
  accent: "ac-brand",
  effect: "fx-auto",
  avatar: "l-signature",
  chatTheme: "t-default",
  frame: "fr-none",
  title: "ti-none",
  badge: "bd-none",
};

/** every id that costs nothing — owned implicitly by every user */
export const DEFAULT_OWNED: string[] = Object.entries(CUSTOMIZATION_CATALOGUE)
  .filter(([, e]) => e.price === 0)
  .map(([id]) => id);
