import { describe, it, expect } from "vitest";
import { settingsPatchSchema, validateWidgetOverrides, clamp, GLASS_OPACITY, GLASS_BLUR, BG_DIM } from "./settings.js";

describe("settings — schema validation", () => {
  it("accepts a well-formed partial patch", () => {
    const r = settingsPatchSchema.safeParse({
      appearance: { backgroundColor: "#170D17", glass: { opacity: 0.7, blurPx: 18, tint: "#2A1623" }, presetId: null },
      disclosure: { mode: "on_interaction" },
      units: { unitPreference: "imperial" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-hex colour", () => {
    expect(settingsPatchSchema.safeParse({ appearance: { backgroundColor: "plum" } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ appearance: { accentColor: "#12345" } }).success).toBe(false);
  });

  it("accepts 8-digit hex (alpha)", () => {
    expect(settingsPatchSchema.safeParse({ appearance: { glass: { opacity: 0.7, blurPx: 18, tint: "#2A162380" } } }).success).toBe(true);
  });

  it("rejects an unknown disclosure mode / camera enum", () => {
    expect(settingsPatchSchema.safeParse({ disclosure: { mode: "sometimes" } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ camera: { formDataVerbosity: "loud" } }).success).toBe(false);
  });

  it("allows a background image url through the schema (host check happens later)", () => {
    expect(settingsPatchSchema.safeParse({ appearance: { backgroundImageUrl: "https://cdn.forma.app/x.jpg" } }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ appearance: { backgroundImageUrl: "not a url" } }).success).toBe(false);
  });
});

describe("settings — widget overrides", () => {
  it("accepts valid custom widget keys (client owns the registry)", () => {
    expect(validateWidgetOverrides({ "readiness-ring": "always", "my-custom-tile": "on_interaction" }))
      .toEqual({ "readiness-ring": "always", "my-custom-tile": "on_interaction" });
  });

  it("rejects a bad key with 422", () => {
    expect(() => validateWidgetOverrides({ "Bad_Key": "always" })).toThrow();
    try {
      validateWidgetOverrides({ "way-too-long-a-widget-key-that-exceeds-forty-characters": "always" });
    } catch (e) {
      expect((e as { status: number }).status).toBe(422);
    }
  });

  it("rejects a bad value with 422", () => {
    try {
      validateWidgetOverrides({ "readiness-ring": "hidden" });
    } catch (e) {
      expect((e as { status: number }).status).toBe(422);
    }
  });

  it("rejects more than 60 keys", () => {
    const big = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`w-${i}`, "always"]));
    expect(() => validateWidgetOverrides(big)).toThrow();
  });
});

describe("settings — clamps", () => {
  it("keeps glass opacity readable and blur bounded", () => {
    expect(clamp(0.1, ...GLASS_OPACITY)).toBe(0.35);
    expect(clamp(2, ...GLASS_OPACITY)).toBe(0.95);
    expect(clamp(200, ...GLASS_BLUR)).toBe(40);
    expect(clamp(-5, ...GLASS_BLUR)).toBe(0);
    expect(clamp(3, ...BG_DIM)).toBe(1);
  });
});
