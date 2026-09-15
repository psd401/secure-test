// Row 67's knob (2026-09-14): the one route that throws on purpose. Anonymous
// → 401 like every teacher route; staff → the throw reaches the caller (which
// in production is Next's onRequestError, slice 2 of the observability note).
import { afterEach, describe, expect, mock, test } from "bun:test";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

const { GET, DebugThrowError } = await import("../app/api/debug/throw/route");

afterEach(() => {
  principal = null;
});

describe("GET /api/debug/throw", () => {
  test("anonymous is turned away before anything throws", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  test("a student is turned away too", async () => {
    principal = { sub: "s1", role: "student", email: "s@example.test" };
    const res = await GET();
    expect([401, 403]).toContain(res.status);
  });

  test("staff gets the deliberate throw", async () => {
    principal = { sub: "t1", role: "staff", email: "t@example.test" };
    await expect(GET()).rejects.toBeInstanceOf(DebugThrowError);
  });
});
