import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

/**
 * Contract-level auth tests (no DB writes). Full lifecycle flows
 * (register → verify → login → lockout → session revoke → refresh rotation)
 * are covered by the manual/integration pass in BACKEND.md against a
 * disposable Postgres.
 */
describe("auth surface", () => {
  it("register rejects a weak password with a validation error", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "x@example.com", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("register rejects a password with too few character classes", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "x@example.com", password: "alllowercase" });
    expect(res.status).toBe(400);
  });

  it("login with a bogus body → 400", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: "not-email" });
    expect(res.status).toBe(400);
  });

  it("refresh with no token → 400 (validation)", async () => {
    const res = await request(app).post("/api/v1/auth/refresh").send({});
    expect(res.status).toBe(400);
  });

  it("refresh with an unknown token → 401 session_expired", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: "this-token-does-not-exist-anywhere" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("session_expired");
  });

  it("verify-email requires a token", async () => {
    const res = await request(app).post("/api/v1/auth/verify-email").send({});
    expect(res.status).toBe(400);
  });

  it("verify-email with an unknown token → token_invalid", async () => {
    const res = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ token: "definitely-not-a-real-token-value" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("token_invalid");
  });

  it("logout-all requires auth", async () => {
    const res = await request(app).post("/api/v1/auth/logout-all");
    expect(res.status).toBe(401);
  });

  it("account & security routes require auth", async () => {
    for (const [method, path] of [
      ["put", "/api/v1/me/password"],
      ["post", "/api/v1/me/email/change"],
      ["get", "/api/v1/me/sessions"],
      ["get", "/api/v1/me/connected-accounts"],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(res.status).toBe(401);
    }
  });

  it("forgot-password always 200 (no account enumeration)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "surely-nobody-here@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("GET /config/auth advertises provider availability", async () => {
    const res = await request(app).get("/api/v1/config/auth");
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveProperty("google");
    expect(res.body.passwordPolicy.minLength).toBe(8);
  });
});
