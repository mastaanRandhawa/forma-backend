import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/errors.js";
import { isProd } from "../env.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({
        error: { code: "conflict", message: "A record with that value already exists" },
      });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: { code: "not_found", message: "Record not found" } });
    }
  }

  console.error(err);
  res.status(500).json({
    error: {
      code: "internal",
      message: "Internal server error",
      ...(isProd ? {} : { detail: err instanceof Error ? err.message : String(err) }),
    },
  });
}
