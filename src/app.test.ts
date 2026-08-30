import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

const app = createApp();

/**
 * Contract tests that don't need a database — routing, auth guard, validation,
 * error shape. Full integration tests (DB round-trips) run against a disposable
 * Postgres; see BACKEND.md §"Testing".
 */
describe("API surface", () => {
  it("health check responds", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("unknown route → 404 with error envelope", async () => {
    const res = await request(app).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("protected route without token → 401", async () => {
    const res = await request(app).get("/api/v1/dashboard");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("invalid body → 400 with validation details", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({ email: "not-an-email", password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(res.body.error.details).toBeDefined();
  });

  it("every domain router is mounted", async () => {
    const domains = [
      "me", "trainer", "library", "workouts", "programs", "sessions", "progress",
      "goals", "chat", "store", "body", "dashboard", "notifications", "achievements",
      "subscription", "config/appearance-presets",
    ];
    for (const d of domains) {
      const res = await request(app).get(`/api/v1/${d}`);
      // mounted routers reject with 401 (auth) or 400/404/500, never a bare 404 "Route not found"
      expect(res.body?.error?.message).not.toBe("Route not found");
    }
  });

  it("PUT /me/settings requires auth", async () => {
    const res = await request(app).put("/api/v1/me/settings").send({ appearance: { reduceMotion: true } });
    expect(res.status).toBe(401);
  });

  it("PUT /me/progression requires auth", async () => {
    const res = await request(app).put("/api/v1/me/progression").send({ gatingEnabled: false });
    expect(res.status).toBe(401);
  });
});
