import { env } from "../env.js";

export interface SocialProfile {
  sub: string;
  email?: string;
  name?: string;
}

/**
 * Verify an Apple / Google identity token.
 *
 * Production: validate the JWT signature against the provider's JWKS
 * (`https://appleid.apple.com/auth/keys` / `https://www.googleapis.com/oauth2/v3/certs`),
 * check `iss`, `aud` (your client id), and `exp`.
 *
 * Dev fallback (no verification configured): accept a base64url-encoded JSON
 * payload `{ sub, email, name }` so the flow is testable end-to-end.
 */
export async function verifySocialToken(
  provider: "apple" | "google",
  identityToken: string,
): Promise<SocialProfile | null> {
  const jwks =
    provider === "apple"
      ? "https://appleid.apple.com/auth/keys"
      : "https://www.googleapis.com/oauth2/v3/certs";

  if (env.NODE_ENV !== "production") {
    try {
      const body = identityToken.split(".")[1] ?? identityToken;
      const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (json.sub) return { sub: String(json.sub), email: json.email, name: json.name };
    } catch {
      /* fall through */
    }
  }

  // TODO: real JWKS verification against `jwks`
  void jwks;
  return null;
}
