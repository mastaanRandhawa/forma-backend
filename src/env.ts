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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
