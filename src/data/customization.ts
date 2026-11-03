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
  | "badge"
  | "colorMode"
  | "font"
  | "persona"
  | "restSound"
  | "celebration";

export interface CatalogueEntry {
  /** what it equips into; null for an unlock with nothing to wear (a program) */
  slot: CustomizationSlot | null;
  price: number;
}

export const CUSTOMIZATION_CATALOGUE: Record<string, CatalogueEntry> = {
  // themes — colour worlds, all free, all render in light + dark
  "aurora-plum": { slot: "theme", price: 0 },
  midnight: { slot: "theme", price: 0 },
  carbon: { slot: "theme", price: 0 },
  sunset: { slot: "theme", price: 0 },
  forest: { slot: "theme", price: 0 },
  arctic: { slot: "theme", price: 0 },
  synthwave: { slot: "theme", price: 0 },
  sakura: { slot: "theme", price: 0 },
  "gold-vault": { slot: "theme", price: 0 },
  nebula: { slot: "theme", price: 0 },
  terminal: { slot: "theme", price: 0 },
  // retired light-only themes — kept so old equipped rows still validate
  cloud: { slot: "theme", price: 0 },
  dusk: { slot: "theme", price: 0 },

  // accents — all free
  "ac-brand": { slot: "accent", price: 0 },
  "ac-ember": { slot: "accent", price: 0 },
  "ac-cyan": { slot: "accent", price: 0 },
  "ac-lime": { slot: "accent", price: 0 },
  "ac-violet": { slot: "accent", price: 0 },
  "ac-gold": { slot: "accent", price: 0 },
  "ac-mint": { slot: "accent", price: 0 },
  "ac-blood": { slot: "accent", price: 0 },
  "ac-rose": { slot: "accent", price: 0 },
  "ac-teal": { slot: "accent", price: 0 },
  "ac-peach": { slot: "accent", price: 0 },
  "ac-indigo": { slot: "accent", price: 0 },
  "ac-forest": { slot: "accent", price: 0 },
  "ac-amber": { slot: "accent", price: 0 },

  // ambient effects
  "fx-auto": { slot: "effect", price: 0 },
  "fx-none": { slot: "effect", price: 0 },
  "fx-glow": { slot: "effect", price: 140 },
  "fx-particles": { slot: "effect", price: 450 },
  "fx-aurora": { slot: "effect", price: 400 },
  "fx-grain": { slot: "effect", price: 160 },
  "fx-scanlines": { slot: "effect", price: 600 },

  // Kai looks
  "l-signature": { slot: "avatar", price: 0 },
  "l-aurora": { slot: "avatar", price: 150 },
  "l-ember": { slot: "avatar", price: 150 },
  "l-frost": { slot: "avatar", price: 150 },
  "l-nebula": { slot: "avatar", price: 450 },
  "l-jade": { slot: "avatar", price: 450 },
  "l-mono": { slot: "avatar", price: 500 },
  "l-gold": { slot: "avatar", price: 1400 },
  "l-holo": { slot: "avatar", price: 2600 },

  // chat skins
  "t-default": { slot: "chatTheme", price: 0 },
  "t-minimal": { slot: "chatTheme", price: 100 },
  "t-terminal": { slot: "chatTheme", price: 120 },
  "t-paper": { slot: "chatTheme", price: 160 },
  "t-bubblegum": { slot: "chatTheme", price: 160 },
  "t-ink": { slot: "chatTheme", price: 400 },

  // profile — frames
  "fr-none": { slot: "frame", price: 0 },
  "fr-ring": { slot: "frame", price: 120 },
  "fr-laurel": { slot: "frame", price: 500 },
  "fr-flame": { slot: "frame", price: 600 },
  "fr-prism": { slot: "frame", price: 1400 },
  "fr-crown": { slot: "frame", price: 3000 },
  // profile — titles
  "ti-none": { slot: "title", price: 0 },
  "ti-earlybird": { slot: "title", price: 150 },
  "ti-ironwilled": { slot: "title", price: 150 },
  "ti-relentless": { slot: "title", price: 500 },
  "ti-machine": { slot: "title", price: 500 },
  "ti-legend": { slot: "title", price: 1600 },
  // profile — badges
  "bd-none": { slot: "badge", price: 0 },
  "bd-spark": { slot: "badge", price: 100 },
  "bd-bolt": { slot: "badge", price: 100 },
  "bd-star": { slot: "badge", price: 400 },
  "bd-diamond": { slot: "badge", price: 1200 },

  // color mode (all free)
  "cm-system": { slot: "colorMode", price: 0 },
  "cm-dark": { slot: "colorMode", price: 0 },
  "cm-light": { slot: "colorMode", price: 0 },

  // font packs
  "fn-system": { slot: "font", price: 0 },
  "fn-mono": { slot: "font", price: 80 },
  "fn-rounded": { slot: "font", price: 120 },
  "fn-serif": { slot: "font", price: 140 },

  // Kai personas: change how Kai talks in chat and during a workout
  "ps-kai": { slot: "persona", price: 0 },
  "ps-drill": { slot: "persona", price: 600 },
  "ps-zen": { slot: "persona", price: 600 },
  "ps-analyst": { slot: "persona", price: 600 },
  "ps-hype": { slot: "persona", price: 600 },

  // rest-timer sounds
  "rs-chime": { slot: "restSound", price: 0 },
  "rs-bell": { slot: "restSound", price: 120 },
  "rs-arcade": { slot: "restSound", price: 180 },
  "rs-sonar": { slot: "restSound", price: 180 },
  "rs-bowl": { slot: "restSound", price: 240 },

  // celebrations after a PR, weekly target or streak milestone
  "cl-confetti": { slot: "celebration", price: 0 },
  "cl-sparks": { slot: "celebration", price: 200 },
  "cl-coins": { slot: "celebration", price: 450 },
  "cl-fireworks": { slot: "celebration", price: 800 },

  // premium programs: unlocks in the plan library
  "pl-powerbuilding": { slot: null, price: 1500 },
  "pl-arms": { slot: null, price: 900 },
  "pl-glutes": { slot: null, price: 900 },
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
  colorMode: "cm-system",
  font: "fn-system",
  persona: "ps-kai",
  restSound: "rs-chime",
  celebration: "cl-confetti",
};

/** every id that costs nothing — owned implicitly by every user */
export const DEFAULT_OWNED: string[] = Object.entries(CUSTOMIZATION_CATALOGUE)
  .filter(([, e]) => e.price === 0)
  .map(([id]) => id);
