import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { appPassState, buyAppPass, buyShield, claimQuest, makePledge, rewardsState, syncTimezone } from "../services/rewards.js";
import { PLEDGE } from "../services/rewards-rules.js";

/**
 * /rewards — streak, rank, quests, shields, pledges and weekly deals.
 * The client sends its IANA timezone as `X-Timezone` so weeks and days are local.
 * `checkins=false` swaps the check-in quest for one that doesn't need check-ins
 * (manual check-ins are a device preference the server can't see).
 */
export const rewardsRouter = Router();
rewardsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

rewardsRouter.use(
  asyncHandler(async (req, _res, next) => {
    await syncTimezone(uid(req), req.header("x-timezone"));
    next();
  }),
);

const checkinsFlag = z.enum(["true", "false"]).default("true").transform((v) => v === "true");

rewardsRouter.get(
  "/state",
  validate({ query: z.object({ checkins: checkinsFlag }) }),
  asyncHandler(async (req, res) => {
    const { checkins } = req.query as unknown as { checkins: boolean };
    res.json(await rewardsState(uid(req), { checkinsEnabled: checkins }));
  }),
);

rewardsRouter.post(
  "/quests/:id/claim",
  validate({ body: z.object({ checkinsEnabled: z.boolean().default(true) }) }),
  asyncHandler(async (req, res) => {
    const { checkinsEnabled } = req.body as { checkinsEnabled: boolean };
    const coins = await claimQuest(uid(req), req.params.id, { checkinsEnabled });
    res.json({ coins, state: await rewardsState(uid(req), { checkinsEnabled }) });
  }),
);

rewardsRouter.post(
  "/shields",
  validate({ body: z.object({ checkinsEnabled: z.boolean().default(true) }) }),
  asyncHandler(async (req, res) => {
    await buyShield(uid(req));
    res.status(201).json(await rewardsState(uid(req), { checkinsEnabled: (req.body as { checkinsEnabled: boolean }).checkinsEnabled }));
  }),
);

rewardsRouter.post(
  "/pledge",
  validate({
    body: z.object({
      stake: z.number().int().refine((n) => (PLEDGE.stakes as readonly number[]).includes(n), "Pick one of the offered stakes"),
      checkinsEnabled: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { stake, checkinsEnabled } = req.body as { stake: number; checkinsEnabled: boolean };
    await makePledge(uid(req), stake);
    res.status(201).json(await rewardsState(uid(req), { checkinsEnabled }));
  }),
);

rewardsRouter.get(
  "/app-pass",
  asyncHandler(async (req, res) => {
    res.json(await appPassState(uid(req)));
  }),
);

rewardsRouter.post(
  "/app-pass",
  validate({ body: z.object({ minutes: z.number().int(), requestId: z.string().min(8).max(64) }) }),
  asyncHandler(async (req, res) => {
    const { minutes, requestId } = req.body as { minutes: number; requestId: string };
    await buyAppPass(uid(req), minutes, requestId);
    res.status(201).json(await appPassState(uid(req)));
  }),
);
