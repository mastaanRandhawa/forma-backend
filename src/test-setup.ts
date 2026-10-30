/**
 * Vitest setup: lets modules that import `env.ts` load in a fresh clone or CI
 * without a `.env`. Values from the shell or `.env` always win; these are only
 * placeholders for whatever is still unset. Tests that query the database still
 * need DATABASE_URL to point at a reachable Postgres.
 */
import "dotenv/config";

const placeholders: Record<string, string> = {
  // Port 1 on purpose: with no real DATABASE_URL, DB tests fail fast instead of
  // logging in to whatever Postgres happens to be listening on :5432.
  DATABASE_URL: "postgresql://placeholder:placeholder@127.0.0.1:1/forma_test",
  JWT_ACCESS_SECRET: "test-access-secret",
  JWT_REFRESH_SECRET: "test-refresh-secret",
};

for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ??= value;
}

// Tests never call the paid Claude API, even with a key in .env: services/ai.ts
// takes its canned path when the key is empty.
process.env.ANTHROPIC_API_KEY = "";
