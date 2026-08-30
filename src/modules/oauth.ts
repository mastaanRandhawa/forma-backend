import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { env } from "../env.js";
import {
  WEARABLE_PROVIDERS,
  type WearableProvider,
  completeOAuth,
  syncConnection,
  verifyState,
} from "../services/wearables.js";
import { prisma } from "../prisma.js";

/**
 * Public wearable-OAuth callback (§3.3). The provider redirects the user's
 * browser here with `?code&state` — there is no bearer token, so this router is
 * mounted WITHOUT `requireAuth`; the signed `state` carries the userId.
 */
export const oauthRouter = Router();

const webRedirect = (params: string) => `${env.WEB_ORIGIN.split(",")[0]!.trim()}/settings?${params}`;

oauthRouter.get(
  "/:provider/callback",
  asyncHandler(async (req, res) => {
    const provider = req.params.provider as WearableProvider;
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (!WEARABLE_PROVIDERS.includes(provider)) return res.redirect(webRedirect("device_error=unknown_provider"));
    if (error) return res.redirect(webRedirect(`device_error=${encodeURIComponent(error)}`));
    if (!code || !state) return res.redirect(webRedirect("device_error=missing_code"));

    const userId = verifyState(state, provider);
    if (!userId) return res.redirect(webRedirect("device_error=bad_state"));

    try {
      await completeOAuth(userId, provider, code);
      const conn = await prisma.deviceConnection.findUnique({ where: { userId_provider: { userId, provider } } });
      if (conn) await syncConnection(conn.id).catch(() => {}); // first pull, best-effort
      res.redirect(webRedirect(`device_connected=${provider}`));
    } catch (e) {
      res.redirect(webRedirect(`device_error=${encodeURIComponent((e as Error).message.slice(0, 120))}`));
    }
  }),
);
