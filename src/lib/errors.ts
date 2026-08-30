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
export const unauthorized = (m = "Unauthorized") => new HttpError(401, m, "unauthorized");
export const forbidden = (m = "Forbidden") => new HttpError(403, m, "forbidden");
export const notFound = (m = "Not found") => new HttpError(404, m, "not_found");
export const conflict = (m = "Conflict") => new HttpError(409, m, "conflict");
export const unprocessable = (m = "Unprocessable entity", d?: unknown) =>
  new HttpError(422, m, "unprocessable", d);
