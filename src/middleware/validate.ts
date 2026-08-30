import type { NextFunction, Request, Response } from "express";
import { z, ZodError, type ZodTypeAny } from "zod";
import { badRequest } from "../lib/errors.js";

type Schemas = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };

/** Validate and coerce req.body / req.query / req.params against zod schemas. */
export const validate =
  (schemas: Schemas) => (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) Object.assign(req.query, schemas.query.parse(req.query));
      if (schemas.params) Object.assign(req.params, schemas.params.parse(req.params));
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(badRequest("Validation failed", err.flatten()));
      } else {
        next(err);
      }
    }
  };

export const cuidParam = (name: string) =>
  z.object({ [name]: z.string().min(1) });
