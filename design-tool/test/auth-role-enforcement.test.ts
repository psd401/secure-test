// Slice 58: proves the role gate on EVERY teacher route by enumerating them
// from disk, not by sampling a few.
//
// Sampling would be the wrong shape of test here. The failure this guards
// against is one route out of forty being missed in the sweep, and a sampled
// test passes happily while that route stays open. Enumerating from the
// filesystem also means a route added later is covered the day it lands,
// without anyone remembering to add it here.
//
// Two passes, and the pair is the point:
//   - no session   → 401 everywhere. Proves the sweep actually REACHES the
//                    guard, rather than the handler erroring earlier and the
//                    403 below being a coincidence.
//   - student token → 403 everywhere. Proves the guard discriminates on role.
import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

let mockSession: { sub: string; role: string } | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      mockSession && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => mockSession,
}));

const APP_ROOT = resolve(import.meta.dir, "../app");
const UUID = "11111111-1111-4111-8111-111111111111";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Routes that legitimately do not take a staff principal.
 *
 * `api/auth` is the login surface — there is no principal yet, by definition.
 *
 * `api/health` is the ALB target-group probe (2026-08-31) — the ALB sends no
 * cookies, and a health check gated on auth would mark every task unhealthy.
 * It reads nothing, so there is nothing to protect.
 *
 * Slice 62 removed the delivery route's entry from this list: it now requires a
 * student principal like any other student route, and is classified below.
 */
const EXCLUDED = [join("api", "auth"), join("api", "health")];

/**
 * Routes that serve the STUDENT principal. Their expectations are the mirror
 * image of a staff route's, so they are classified rather than excluded — an
 * exclusion would stop checking them entirely, and a student route that
 * accidentally accepted a teacher is exactly as wrong as the reverse.
 */
const STUDENT_ROUTES = new Set([
  join("api", "test-sessions", "redeem"),
  join("api", "me", "sittings"),
  join("api", "attempts"),
  join("api", "attempts", "[attemptId]", "responses", "[itemId]"),
  join("api", "attempts", "[attemptId]", "submit"),
  join("api", "attempts", "[attemptId]", "events"),
  join("api", "attempts", "[attemptId]", "peek", "pending"),
  join("api", "attempts", "[attemptId]", "peek", "upload"),
  join("api", "assessments", "[id]", "delivery"),
  join("api", "attempts", "[attemptId]", "responses", "[itemId]", "upload-url"),
  join("api", "attempts", "[attemptId]", "responses", "[itemId]", "upload"),
  // Batch 3 slice 2: the client's error drain. Student-authed but NOT
  // attempt-scoped — a failed sign-in or a crash on the previous launch has
  // no attempt to post against.
  join("api", "client-errors"),
]);

/**
 * R1 (docs/reporting-design.md): a route file whose METHODS split by role.
 * `attempts/[attemptId]/events` is the only one — the client POSTs its events
 * there and, since R1, the owning teacher GETs them back for the per-student
 * page's integrity timeline. Classification is per file everywhere else, so
 * this map is the exception rather than a second scheme: the named methods are
 * held to the staff expectations, the rest of the file to the student ones.
 */
const STAFF_METHODS_ON_STUDENT_ROUTES = new Map<string, Set<string>>([
  [join("api", "attempts", "[attemptId]", "events"), new Set(["GET"])],
]);

function staffMethodsFor(path: string): Set<string> {
  return STAFF_METHODS_ON_STUDENT_ROUTES.get(path) ?? new Set();
}

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findRouteFiles(full));
    } else if (entry.name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

function relativeRoute(file: string): string {
  return file.slice(APP_ROOT.length + 1).replace(/\/route\.ts$/, "");
}

/** Every `[segment]` in the path gets a syntactically valid uuid. */
function paramsFor(routePath: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const segment of routePath.split("/")) {
    if (segment.startsWith("[") && segment.endsWith("]")) {
      params[segment.slice(1, -1)] = UUID;
    }
  }
  return params;
}

const allRoutes = findRouteFiles(APP_ROOT)
  .map((file) => ({ file, path: relativeRoute(file) }))
  .filter(({ path }) => !EXCLUDED.some((prefix) => path.startsWith(prefix)))
  .sort((a, b) => a.path.localeCompare(b.path));

const routes = allRoutes.filter(({ path }) => !STUDENT_ROUTES.has(path));
const studentRoutes = allRoutes.filter(({ path }) => STUDENT_ROUTES.has(path));

async function statusesFor(file: string, path: string): Promise<Map<string, number>> {
  const mod = (await import(file)) as Record<string, unknown>;
  const params = paramsFor(path);
  const results = new Map<string, number>();
  for (const method of METHODS) {
    const handler = mod[method];
    if (typeof handler !== "function") continue;
    const url = `http://localhost/${path.replace(/\[(\w+)\]/g, UUID)}`;
    const response = (await (handler as Function)(
      new Request(url, { method }),
      { params: Promise.resolve(params) },
    )) as Response;
    results.set(method, response.status);
  }
  return results;
}

describe("role enforcement across every teacher route", () => {
  test("every classified student route exists on disk", () => {
    // Guards the classification itself: a typo in STUDENT_ROUTES would silently
    // drop a route from the staff sweep without adding it to the student one.
    expect(studentRoutes.length).toBe(STUDENT_ROUTES.size);
  });

  test("student routes accept a student and refuse staff", async () => {
    for (const { file, path } of studentRoutes) {
      const staffMethods = staffMethodsFor(path);
      mockSession = { sub: "student-sub", role: "student" };
      for (const [method, status] of await statusesFor(file, path)) {
        if (staffMethods.has(method)) continue;
        expect([401, 403]).not.toContain(status);
        expect(`${method} ${path} ${status}`).toBeTruthy();
      }
      mockSession = { sub: "teacher-sub", role: "staff" };
      for (const [method, status] of await statusesFor(file, path)) {
        if (staffMethods.has(method)) continue;
        expect(status).toBe(403);
      }
      mockSession = null;
      for (const [method, status] of await statusesFor(file, path)) {
        if (staffMethods.has(method)) continue;
        expect(status).toBe(401);
      }
    }
  });

  test("the staff methods on a student route are the mirror image", async () => {
    for (const [path, methods] of STAFF_METHODS_ON_STUDENT_ROUTES) {
      const route = allRoutes.find((r) => r.path === path);
      expect(route).toBeDefined();
      const seen = new Set<string>();

      mockSession = { sub: "teacher-sub", role: "staff" };
      for (const [method, status] of await statusesFor(route!.file, path)) {
        if (!methods.has(method)) continue;
        seen.add(method);
        expect([401, 403]).not.toContain(status);
      }
      // The classification must name methods that actually exist, or it is a
      // silent exemption for a route nobody is checking.
      expect([...seen].sort()).toEqual([...methods].sort());

      mockSession = { sub: "student-sub", role: "student" };
      for (const [method, status] of await statusesFor(route!.file, path)) {
        if (methods.has(method)) expect(status).toBe(403);
      }
      mockSession = null;
      for (const [method, status] of await statusesFor(route!.file, path)) {
        if (methods.has(method)) expect(status).toBe(401);
      }
    }
  });

  test("the sweep actually found the routes", () => {
    // Guards against a refactor that moves route files and turns this whole
    // suite into a no-op that passes.
    expect(routes.length).toBeGreaterThanOrEqual(29);
    expect(routes.some((r) => r.path.includes("assessments"))).toBe(true);
    expect(routes.some((r) => r.path.startsWith("preview"))).toBe(true);
  });

  test("every route refuses an unauthenticated caller with 401", async () => {
    mockSession = null;
    const wrong: string[] = [];
    for (const { file, path } of routes) {
      for (const [method, status] of await statusesFor(file, path)) {
        if (status !== 401) wrong.push(`${method} /${path} → ${status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every route refuses a student token with 403", async () => {
    mockSession = { sub: "student-sub", role: "student" };
    const wrong: string[] = [];
    for (const { file, path } of routes) {
      for (const [method, status] of await statusesFor(file, path)) {
        if (status !== 403) wrong.push(`${method} /${path} → ${status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every route refuses a guardian token with 403", async () => {
    // Family roles are denied outright rather than falling into the
    // unknown-role staff default.
    mockSession = { sub: "guardian-sub", role: "guardian" };
    const wrong: string[] = [];
    for (const { file, path } of routes) {
      for (const [method, status] of await statusesFor(file, path)) {
        if (status !== 403) wrong.push(`${method} /${path} → ${status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a staff token gets past the ROLE gate on every route", async () => {
    // It will then hit ownership, validation or not-found — all fine. What must
    // not happen is a 401/403, which would mean the gate rejected legitimate
    // staff and the sweep above was passing for the wrong reason.
    mockSession = { sub: "teacher-sub", role: "staff" };
    const refused: string[] = [];
    for (const { file, path } of routes) {
      for (const [method, status] of await statusesFor(file, path)) {
        if (status === 401 || status === 403) refused.push(`${method} /${path} → ${status}`);
      }
    }
    expect(refused).toEqual([]);
  });
});
