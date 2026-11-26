/**
 * Helpers for database-backed tests. They only run when RUN_DB_TESTS=1 and a
 * disposable Postgres is configured (never point them at a real database):
 *
 *   RUN_DB_TESTS=1 npm test
 *
 * Every user they create has an `it-` email prefix and is removed afterwards.
 */
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";

export const dbTests = process.env.RUN_DB_TESTS === "1";
export const app = createApp();

export interface TestUser {
  id: string;
  token: string;
  auth: { Authorization: string; "X-Client-Platform": string };
}

export async function makeUser(label: string): Promise<TestUser> {
  const email = `it-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@forma.test`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .set("X-Client-Platform", "native")
    .send({ email, password: "Test-Pass-12345x", firstName: "IT" });
  if (res.status >= 300) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  // these tests are about training data, not the verification flow
  await prisma.user.update({ where: { id: res.body.user.id }, data: { emailVerifiedAt: new Date() } });
  const token = res.body.accessToken as string;
  return { id: res.body.user.id, token, auth: { Authorization: `Bearer ${token}`, "X-Client-Platform": "native" } };
}

export async function cleanupUsers() {
  await prisma.user.deleteMany({ where: { email: { startsWith: "it-" } } });
}

export const exerciseBySlug = async (slug: string) => prisma.exercise.findUniqueOrThrow({ where: { slug } });

/** Start an ad-hoc session with the given exercises, log sets, finish. Returns the finished session. */
export async function runSession(
  u: TestUser,
  exerciseId: string,
  sets: Record<string, unknown>[],
): Promise<Record<string, any>> {
  const s = await request(app).post("/api/v1/sessions").set(u.auth).send({ name: "IT session" });
  const perf = await request(app).post(`/api/v1/sessions/${s.body.id}/performances`).set(u.auth).send({ exerciseId, order: 0 });
  for (let i = 0; i < sets.length; i++) {
    const r = await request(app)
      .put(`/api/v1/sessions/${s.body.id}/performances/${perf.body.id}/sets/${i + 1}`)
      .set(u.auth)
      .send({ completed: true, ...sets[i] });
    if (r.status >= 300) throw new Error(`set failed: ${JSON.stringify(r.body)}`);
  }
  const fin = await request(app).post(`/api/v1/sessions/${s.body.id}/finish`).set(u.auth).send({});
  if (fin.status >= 300) throw new Error(`finish failed: ${JSON.stringify(fin.body)}`);
  return fin.body;
}
