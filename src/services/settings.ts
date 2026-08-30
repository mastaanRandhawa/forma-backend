import { z } from "zod";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { badRequest, unprocessable, forbidden } from "../lib/errors.js";
import { BRAND_ACCENT } from "../data/appearance.js";
import { TIER_ORDER } from "../data/progression.js";
import { readProgression } from "./progression.js";

// ── validation ──────────────────────────────────────────────────────────────
export const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const hex = z.string().regex(HEX, "must be a #RRGGBB or #RRGGBBAA hex colour");
export const WIDGET_KEY = /^[a-z0-9-]{1,40}$/;
export const DISCLOSURE_VALUES = ["always", "on_interaction"] as const;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const GLASS_OPACITY = [0.35, 0.95] as const;
export const GLASS_BLUR = [0, 40] as const;
export const BG_DIM = [0, 1] as const;

/** Pure — throws `unprocessable` on any bad key/value (used by the PUT handler + tests). */
export function validateWidgetOverrides(overrides: Record<string, unknown>): Record<string, "always" | "on_interaction"> {
  const entries = Object.entries(overrides);
  if (entries.length > 60) throw unprocessable("At most 60 widget overrides");
  const out: Record<string, "always" | "on_interaction"> = {};
  for (const [k, v] of entries) {
    if (!WIDGET_KEY.test(k)) throw unprocessable(`Invalid widget key "${k}"`);
    if (v !== "always" && v !== "on_interaction") {
      throw unprocessable(`Override "${k}" must be "always" or "on_interaction"`);
    }
    out[k] = v;
  }
  return out;
}

const gradientSchema = z.object({
  angle: z.number(),
  stops: z.array(z.object({ color: hex, at: z.number().min(0).max(1) })).min(2),
});

const glassSchema = z.object({
  opacity: z.number(),
  blurPx: z.number(),
  tint: hex,
});

const appearancePatch = z
  .object({
    presetId: z.string().nullable(),
    backgroundMode: z.enum(["solid", "gradient", "image"]),
    backgroundColor: hex,
    backgroundGradient: gradientSchema.nullable(),
    backgroundImageUrl: z.string().url().nullable(),
    backgroundDim: z.number(),
    glass: glassSchema,
    accentColor: hex.nullable(),
    reduceMotion: z.boolean(),
  })
  .partial();

const disclosurePatch = z
  .object({
    mode: z.enum(["always", "on_interaction"]),
    widgetOverrides: z.record(z.string(), z.string()),
  })
  .partial();

export const settingsPatchSchema = z
  .object({
    camera: z
      .object({
        formDataVerbosity: z.enum(["minimal", "categorical", "detailed"]),
        saveHighlightClips: z.boolean(),
      })
      .partial(),
    units: z
      .object({
        unitPreference: z.enum(["metric", "imperial"]),
        weekStartsMonday: z.boolean(),
      })
      .partial(),
    appearance: appearancePatch,
    disclosure: disclosurePatch,
  })
  .partial();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// ── assembly ────────────────────────────────────────────────────────────────

const THEME_FIELDS = [
  "backgroundMode",
  "backgroundColor",
  "backgroundGradient",
  "backgroundImageUrl",
  "backgroundDim",
  "glass",
  "accentColor",
] as const;

function imageHostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const hosts = (env.APPEARANCE_IMAGE_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    return hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

async function appearanceRow(userId: string) {
  return prisma.userAppearance.upsert({ where: { userId }, update: {}, create: { userId } });
}
async function disclosureRow(userId: string) {
  return prisma.userDisclosure.upsert({ where: { userId }, update: {}, create: { userId } });
}

/** preset defaults → user overrides, already merged for the client. */
async function appearanceView(userId: string) {
  const row = await appearanceRow(userId);
  let base = {
    backgroundMode: row.backgroundMode,
    backgroundColor: row.backgroundColor,
    backgroundGradient: row.backgroundGradient,
    backgroundImageUrl: row.backgroundImageUrl,
    backgroundDim: row.backgroundDim,
    glass: { opacity: row.glassOpacity, blurPx: row.glassBlurPx, tint: row.glassTint },
    accentColor: row.accentColor ?? BRAND_ACCENT,
  };

  if (row.presetId) {
    const preset = await prisma.backgroundPreset.findUnique({ where: { id: row.presetId } });
    if (preset) {
      const g = preset.glass as { opacity: number; blurPx: number; tint: string };
      base = {
        backgroundMode: preset.mode,
        backgroundColor: preset.backgroundColor ?? row.backgroundColor,
        backgroundGradient: preset.gradient ?? null,
        backgroundImageUrl: preset.imageUrl ?? null,
        backgroundDim: preset.backgroundDim,
        glass: g,
        accentColor: preset.accentColor ?? BRAND_ACCENT,
      };
    }
  }

  return { presetId: row.presetId, ...base, reduceMotion: row.reduceMotion, updatedAt: row.updatedAt };
}

export async function getSettingsBundle(userId: string) {
  const [user, disclosure, appearance, progression] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { formDataVerbosity: true, saveHighlightClips: true, unitPreference: true, weekStartsMonday: true },
    }),
    disclosureRow(userId),
    appearanceView(userId),
    readProgression(userId),
  ]);

  return {
    camera: { formDataVerbosity: user.formDataVerbosity, saveHighlightClips: user.saveHighlightClips },
    units: { unitPreference: user.unitPreference, weekStartsMonday: user.weekStartsMonday },
    appearance,
    disclosure: { mode: disclosure.mode, widgetOverrides: disclosure.widgetOverrides ?? {} },
    progression: {
      tier: progression.tier,
      unlockedFeatures: progression.unlockedFeatures,
      gatingEnabled: progression.gatingEnabled,
      nextUnlock: progression.nextUnlock,
    },
  };
}

// ── patch ───────────────────────────────────────────────────────────────────

async function permittedPreset(userId: string, presetId: string) {
  const preset = await prisma.backgroundPreset.findUnique({ where: { id: presetId } });
  if (!preset) throw badRequest(`Unknown preset "${presetId}"`);

  if (preset.minTier) {
    const prog = await readProgression(userId);
    if (TIER_ORDER.indexOf(prog.tier) < TIER_ORDER.indexOf(preset.minTier as never)) {
      throw forbidden(`Preset "${presetId}" unlocks at the ${preset.minTier} tier`);
    }
  }
  if (preset.storeItemId) {
    const owned = await prisma.userStoreItem.findUnique({
      where: { userId_storeItemId: { userId, storeItemId: preset.storeItemId } },
    });
    if (!owned) throw forbidden(`Preset "${presetId}" requires the "${preset.storeItemId}" theme`);
  }
  return preset;
}

export async function applySettingsPatch(userId: string, patch: SettingsPatch) {
  // ── camera / units → User columns ─────────────────────────────────────────
  const userData: Record<string, unknown> = {};
  if (patch.camera?.formDataVerbosity !== undefined) userData.formDataVerbosity = patch.camera.formDataVerbosity;
  if (patch.camera?.saveHighlightClips !== undefined) userData.saveHighlightClips = patch.camera.saveHighlightClips;
  if (patch.units?.unitPreference !== undefined) userData.unitPreference = patch.units.unitPreference;
  if (patch.units?.weekStartsMonday !== undefined) userData.weekStartsMonday = patch.units.weekStartsMonday;
  if (Object.keys(userData).length) await prisma.user.update({ where: { id: userId }, data: userData });

  // ── disclosure ───────────────────────────────────────────────────────────
  if (patch.disclosure) {
    const d = patch.disclosure;
    const data: Record<string, unknown> = {};
    if (d.mode !== undefined) data.mode = d.mode;
    if (d.widgetOverrides !== undefined) {
      data.widgetOverrides = validateWidgetOverrides(d.widgetOverrides as Record<string, unknown>);
    }
    await prisma.userDisclosure.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  }

  // ── appearance ───────────────────────────────────────────────────────────
  if (patch.appearance) {
    const a = patch.appearance;
    await appearanceRow(userId);
    const data: Record<string, unknown> = {};

    // 1. explicit preset selection
    if (a.presetId !== undefined) {
      if (a.presetId === null) {
        data.presetId = null;
      } else {
        const preset = await permittedPreset(userId, a.presetId);
        const g = preset.glass as { opacity: number; blurPx: number; tint: string };
        Object.assign(data, {
          presetId: preset.id,
          backgroundMode: preset.mode,
          backgroundColor: preset.backgroundColor ?? "#170D17",
          backgroundGradient: preset.gradient ?? null,
          backgroundImageUrl: preset.imageUrl ?? null,
          backgroundDim: clamp(preset.backgroundDim, 0, 1),
          glassOpacity: clamp(g.opacity, 0.35, 0.95),
          glassBlurPx: Math.round(clamp(g.blurPx, 0, 40)),
          glassTint: g.tint,
          accentColor: preset.accentColor ?? null,
        });
      }
    }

    // 2. hand-edits — any theme field nulls the preset link
    const touchesTheme = THEME_FIELDS.some((f) => a[f] !== undefined);
    if (touchesTheme) data.presetId = null;

    if (a.backgroundMode !== undefined) data.backgroundMode = a.backgroundMode;
    if (a.backgroundColor !== undefined) data.backgroundColor = a.backgroundColor;
    if (a.backgroundGradient !== undefined) data.backgroundGradient = a.backgroundGradient;
    if (a.backgroundImageUrl !== undefined) {
      if (a.backgroundImageUrl !== null && !imageHostAllowed(a.backgroundImageUrl)) {
        throw unprocessable("backgroundImageUrl must be https and on an allowlisted host");
      }
      data.backgroundImageUrl = a.backgroundImageUrl;
    }
    if (a.backgroundDim !== undefined) data.backgroundDim = clamp(a.backgroundDim, 0, 1);
    if (a.glass !== undefined) {
      data.glassOpacity = clamp(a.glass.opacity, 0.35, 0.95);
      data.glassBlurPx = Math.round(clamp(a.glass.blurPx, 0, 40));
      data.glassTint = a.glass.tint;
    }
    if (a.accentColor !== undefined) data.accentColor = a.accentColor;
    if (a.reduceMotion !== undefined) data.reduceMotion = a.reduceMotion; // meta — does not drop the preset

    await prisma.userAppearance.update({ where: { userId }, data });
  }

  return getSettingsBundle(userId);
}
