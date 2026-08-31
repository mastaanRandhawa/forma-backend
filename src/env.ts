import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  WEB_ORIGIN: z.string().default("http://localhost:5178"),

  // Public URL of the web app — used to build verification / reset links in email.
  APP_WEB_URL: z.string().optional(),

  // Outbound email. Unset SMTP_URL ⇒ the "console" transport logs the message
  // (links/codes) to the server log — fine for dev, swap in SMTP for production.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Forma <no-reply@forma.app>"),

  // Optional social-login client ids surfaced to the web app via /config.
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional().default(""),
  OAUTH_APPLE_CLIENT_ID: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AI_MODEL: z.string().default("claude-sonnet-5"),
  // hosts allowed for user-supplied appearance background images (comma-separated)
  APPEARANCE_IMAGE_HOSTS: z.string().default("storage.local,cdn.forma.app"),

  // Wearable OAuth (§3.3). Public origin the provider redirects back to — must
  // match the redirect URI registered in each provider's dashboard.
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  WHOOP_CLIENT_ID: z.string().optional().default(""),
  WHOOP_CLIENT_SECRET: z.string().optional().default(""),
  OURA_CLIENT_ID: z.string().optional().default(""),
  OURA_CLIENT_SECRET: z.string().optional().default(""),
  GARMIN_CLIENT_ID: z.string().optional().default(""),
  GARMIN_CLIENT_SECRET: z.string().optional().default(""),

  // Food logging. USDA FoodData Central key stays server-side — all USDA calls
  // are proxied through /api/v1/food/*. Empty ⇒ text search degrades to Open
  // Food Facts only. Open Food Facts asks for an identifying User-Agent.
  USDA_FDC_API_KEY: z.string().optional().default(""),
  OPEN_FOOD_FACTS_USER_AGENT: z
    .string()
    .default("Forma/1.0 (https://forma.app; nutrition@forma.app)"),
  // days a cached Food row is considered fresh before it is re-fetched from source
  FOOD_CACHE_TTL_DAYS: z.coerce.number().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";

/** Where the web app lives — for links embedded in outbound email. */
export const appWebUrl = (env.APP_WEB_URL ?? env.WEB_ORIGIN.split(",")[0]!).trim().replace(/\/$/, "");
