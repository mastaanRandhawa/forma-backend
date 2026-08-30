import crypto from "node:crypto";
import { env } from "../env.js";
import { prisma } from "../prisma.js";

/**
 * Third-party wearable OAuth + sync (§3.3). WHOOP and Oura use standard OAuth2
 * (auth-code + refresh). Garmin uses OAuth1.0a and its Health API needs a
 * partner agreement — it's wired as a provider but reports "not configured"
 * until that flow is implemented.
 *
 * Nothing here runs unless the matching CLIENT_ID / CLIENT_SECRET env vars are
 * set, so a default deployment is unaffected.
 */

export type WearableProvider = "whoop" | "oura" | "garmin";
export const WEARABLE_PROVIDERS: WearableProvider[] = ["whoop", "oura", "garmin"];

export interface NormalizedSample {
  type: "sleep" | "hrv" | "resting_hr";
  value: number;
  unit: string;
  recordedAt: Date;
}

interface OAuth2Config {
  kind: "oauth2";
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  fetchDaily: (accessToken: string) => Promise<NormalizedSample[]>;
}
interface UnavailableConfig {
  kind: "unavailable";
  reason: string;
}
type ProviderConfig = OAuth2Config | UnavailableConfig;

export const redirectUri = (p: WearableProvider) => `${env.API_PUBLIC_URL}/api/v1/me/devices/${p}/callback`;

function whoop(): ProviderConfig {
  if (!env.WHOOP_CLIENT_ID || !env.WHOOP_CLIENT_SECRET)
    return { kind: "unavailable", reason: "WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET not set" };
  return {
    kind: "oauth2",
    clientId: env.WHOOP_CLIENT_ID,
    clientSecret: env.WHOOP_CLIENT_SECRET,
    authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
    tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
    scope: "read:recovery read:sleep read:profile offline",
    fetchDaily: fetchWhoopDaily,
  };
}

function oura(): ProviderConfig {
  if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET)
    return { kind: "unavailable", reason: "OURA_CLIENT_ID / OURA_CLIENT_SECRET not set" };
  return {
    kind: "oauth2",
    clientId: env.OURA_CLIENT_ID,
    clientSecret: env.OURA_CLIENT_SECRET,
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: "https://api.ouraring.com/oauth/token",
    scope: "daily heartrate personal",
    fetchDaily: fetchOuraDaily,
  };
}

export function providerConfig(p: WearableProvider): ProviderConfig {
  if (p === "whoop") return whoop();
  if (p === "oura") return oura();
  return { kind: "unavailable", reason: "Garmin Health API needs a partner agreement + OAuth1.0a (not implemented)" };
}

export function isConfigured(p: WearableProvider): boolean {
  return providerConfig(p).kind === "oauth2";
}

// ── signed state (CSRF + carries the userId across the redirect) ────────────
export function signState(userId: string, provider: WearableProvider): string {
  const payload = `${userId}.${provider}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`;
  const sig = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifyState(state: string, provider: WearableProvider): string | null {
  const [b64, sig] = state.split(".");
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, "base64url").toString();
  const expected = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [userId, statedProvider, tsStr] = payload.split(".");
  if (statedProvider !== provider) return null;
  if (Date.now() - Number(tsStr) > 10 * 60_000) return null; // 10-minute window
  return userId ?? null;
}

// ── authorize URL ──────────────────────────────────────────────────────────
export function authorizeUrl(userId: string, provider: WearableProvider): string {
  const cfg = providerConfig(provider);
  if (cfg.kind !== "oauth2") throw new Error(cfg.reason);
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri(provider));
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("state", signState(userId, provider));
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [k: string]: unknown;
}

async function tokenRequest(cfg: OAuth2Config, provider: WearableProvider, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri(provider),
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`${provider} token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/** Exchange the auth code and persist the connection. */
export async function completeOAuth(userId: string, provider: WearableProvider, code: string) {
  const cfg = providerConfig(provider);
  if (cfg.kind !== "oauth2") throw new Error(cfg.reason);
  const tok = await tokenRequest(cfg, provider, { grant_type: "authorization_code", code });
  await prisma.deviceConnection.upsert({
    where: { userId_provider: { userId, provider } },
    update: {
      status: "connected",
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
      scope: tok.scope ?? cfg.scope,
      lastError: null,
      lastErrorAt: null,
    },
    create: {
      userId,
      provider,
      status: "connected",
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
      scope: tok.scope ?? cfg.scope,
    },
  });
}

async function validAccessToken(conn: { id: string; provider: string; accessToken: string | null; refreshToken: string | null; tokenExpiresAt: Date | null }): Promise<string> {
  const provider = conn.provider as WearableProvider;
  const cfg = providerConfig(provider);
  if (cfg.kind !== "oauth2") throw new Error(cfg.reason);
  const fresh = conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() > 60_000;
  if (fresh && conn.accessToken) return conn.accessToken;
  if (!conn.refreshToken) {
    if (conn.accessToken) return conn.accessToken;
    throw new Error("token expired and no refresh token");
  }
  const tok = await tokenRequest(cfg, provider, { grant_type: "refresh_token", refresh_token: conn.refreshToken });
  await prisma.deviceConnection.update({
    where: { id: conn.id },
    data: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? conn.refreshToken,
      tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
    },
  });
  return tok.access_token;
}

/** Pull the latest daily metrics for one connection into ProgressMetric rows. */
export async function syncConnection(connId: string): Promise<{ ingested: number }> {
  const conn = await prisma.deviceConnection.findUniqueOrThrow({ where: { id: connId } });
  const provider = conn.provider as WearableProvider;
  const cfg = providerConfig(provider);
  if (cfg.kind !== "oauth2") throw new Error(cfg.reason);
  try {
    const token = await validAccessToken(conn);
    const samples = await cfg.fetchDaily(token);
    // dedupe on (userId, type, recordedAt) among health_sync rows
    const existing = await prisma.progressMetric.findMany({
      where: {
        userId: conn.userId,
        source: "health_sync",
        metricType: { in: [...new Set(samples.map((s) => s.type))] as never[] },
        recordedAt: { in: samples.map((s) => s.recordedAt) },
      },
      select: { metricType: true, recordedAt: true },
    });
    const seen = new Set(existing.map((e) => `${e.metricType}@${e.recordedAt.getTime()}`));
    const fresh = samples.filter((s) => !seen.has(`${s.type}@${s.recordedAt.getTime()}`));
    if (fresh.length)
      await prisma.progressMetric.createMany({
        data: fresh.map((s) => ({ userId: conn.userId, metricType: s.type as never, value: s.value, unit: s.unit, recordedAt: s.recordedAt, source: "health_sync" as const })),
      });
    await prisma.deviceConnection.update({
      where: { id: conn.id },
      data: { lastSyncAt: new Date(), status: "connected", lastError: null, lastErrorAt: null },
    });
    return { ingested: fresh.length };
  } catch (err) {
    await prisma.deviceConnection.update({
      where: { id: conn.id },
      data: { status: "error", lastError: (err as Error).message.slice(0, 300), lastErrorAt: new Date() },
    });
    throw err;
  }
}

export async function revokeConnection(userId: string, provider: WearableProvider) {
  await prisma.deviceConnection.deleteMany({ where: { userId, provider } });
  // Best-effort upstream revoke would go here (provider-specific endpoints).
}

// ── provider daily fetchers ────────────────────────────────────────────────
async function fetchWhoopDaily(accessToken: string): Promise<NormalizedSample[]> {
  const h = { authorization: `Bearer ${accessToken}` };
  const out: NormalizedSample[] = [];

  const rec = await fetch("https://api.prod.whoop.com/developer/v1/recovery?limit=7", { headers: h });
  if (rec.ok) {
    const data = (await rec.json()) as { records?: Array<{ created_at: string; score?: { hrv_rmssd_milli?: number; resting_heart_rate?: number } }> };
    for (const r of data.records ?? []) {
      const at = new Date(r.created_at);
      if (r.score?.hrv_rmssd_milli != null) out.push({ type: "hrv", value: Math.round(r.score.hrv_rmssd_milli), unit: "ms", recordedAt: at });
      if (r.score?.resting_heart_rate != null) out.push({ type: "resting_hr", value: Math.round(r.score.resting_heart_rate), unit: "bpm", recordedAt: at });
    }
  }

  const sleep = await fetch("https://api.prod.whoop.com/developer/v1/activity/sleep?limit=7", { headers: h });
  if (sleep.ok) {
    const data = (await sleep.json()) as { records?: Array<{ start: string; end: string; nap?: boolean; score?: { stage_summary?: { total_awake_time_milli?: number } } }> };
    for (const r of data.records ?? []) {
      if (r.nap) continue;
      const gross = (Date.parse(r.end) - Date.parse(r.start)) / 3_600_000;
      const awake = (r.score?.stage_summary?.total_awake_time_milli ?? 0) / 3_600_000;
      const hours = Math.round((gross - awake) * 10) / 10;
      if (hours > 0 && hours < 20) out.push({ type: "sleep", value: hours, unit: "h", recordedAt: new Date(r.end) });
    }
  }
  return out;
}

async function fetchOuraDaily(accessToken: string): Promise<NormalizedSample[]> {
  const h = { authorization: `Bearer ${accessToken}` };
  const start = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const res = await fetch(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${start}&end_date=${end}`, { headers: h });
  if (!res.ok) throw new Error(`oura sleep fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    data?: Array<{ day: string; total_sleep_duration?: number; average_hrv?: number; lowest_heart_rate?: number }>;
  };
  const out: NormalizedSample[] = [];
  for (const d of data.data ?? []) {
    const at = new Date(`${d.day}T12:00:00Z`);
    if (d.total_sleep_duration) out.push({ type: "sleep", value: Math.round((d.total_sleep_duration / 3600) * 10) / 10, unit: "h", recordedAt: at });
    if (d.average_hrv) out.push({ type: "hrv", value: Math.round(d.average_hrv), unit: "ms", recordedAt: at });
    if (d.lowest_heart_rate) out.push({ type: "resting_hr", value: Math.round(d.lowest_heart_rate), unit: "bpm", recordedAt: at });
  }
  return out;
}
