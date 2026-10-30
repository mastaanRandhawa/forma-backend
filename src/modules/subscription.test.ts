import { describe, it, expect } from "vitest";
import { assertReceiptValidationAvailable } from "./subscription.js";
import { HttpError } from "../lib/errors.js";

describe("receipt validation guard", () => {
  it("refuses unverified receipts in production", () => {
    let err: unknown;
    try {
      assertReceiptValidationAvailable(true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(501);
    expect((err as HttpError).code).toBe("receipt_validation_unavailable");
  });

  it("keeps the dev stub usable outside production", () => {
    expect(() => assertReceiptValidationAvailable(false)).not.toThrow();
  });
});
