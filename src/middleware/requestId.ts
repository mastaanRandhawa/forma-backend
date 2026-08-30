import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Attach a request id (echo an inbound X-Request-Id, else generate one). */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = req.header("x-request-id") || crypto.randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader("x-request-id", id);
  next();
}
