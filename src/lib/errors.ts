export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m = "Bad request", d?: unknown) => new HttpError(400, m, "bad_request", d);
/** 400 with a specific machine-readable `code` (e.g. "token_expired"). */
export const badRequestCode = (code: string, m = "Bad request") => new HttpError(400, m, code);
export const unauthorized = (m = "Unauthorized", code = "unauthorized") => new HttpError(401, m, code);
export const forbidden = (m = "Forbidden", code = "forbidden") => new HttpError(403, m, code);
export const notFound = (m = "Not found") => new HttpError(404, m, "not_found");
export const conflict = (m = "Conflict") => new HttpError(409, m, "conflict");
export const unprocessable = (m = "Unprocessable entity", d?: unknown) =>
  new HttpError(422, m, "unprocessable", d);
export const locked = (m = "Account locked", code = "account_locked") => new HttpError(423, m, code);
export const tooManyRequests = (m = "Too many requests", code = "too_many_requests") =>
  new HttpError(429, m, code);
