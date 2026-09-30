// The server-side record of a refused student (roadmap U-11, 2026-09-30):
// a structured line an operator can find, and never the address.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { closeDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setLogSink, type LogSink } from "../lib/log";
import { emailRef, logResolutionFailure } from "../lib/api/resolutionLog";
import { clearRoster, seedRoster, studentPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`resolution-log tests require the test DB; got: ${url}`);
  }
};

// emailRef is keyed by the session secret; the suite may run without .env.local.
process.env.DESIGN_TOOL_SESSION_SECRET ??= "resolution-log-test-secret";

let principal: { sub: string; role: string; email?: string } | null = null;

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

let lines: Array<Record<string, unknown>> = [];
let previous: LogSink;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  previous = setLogSink((line) => lines.push(JSON.parse(line)));
});

afterEach(() => {
  lines = [];
  principal = null;
});

afterAll(async () => {
  setLogSink(previous);
  await clearRoster();
  await closeDb();
});

const ADDRESS = "Missing.Kid@edtools.psd401.net";

describe("emailRef", () => {
  test("stable across case and whitespace, 16 hex, not the address", () => {
    const ref = emailRef(ADDRESS);
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(emailRef(`  ${ADDRESS.toLowerCase()} `)).toBe(ref);
    expect(emailRef("other@edtools.psd401.net")).not.toBe(ref);
  });

  test("null without an address", () => {
    expect(emailRef(undefined)).toBeNull();
    expect(emailRef("  ")).toBeNull();
  });
});

describe("logResolutionFailure", () => {
  test("account-level refusals warn; not_in_sitting is info", () => {
    logResolutionFailure({ route: "R", reason: "not_on_roster", session: { sub: "s1", email: ADDRESS } });
    logResolutionFailure({ route: "R", reason: "not_in_sitting", session: { sub: "s1", email: ADDRESS }, sittingId: "x" });
    expect(lines.map((l) => [l.level, l.event, l.reason])).toEqual([
      ["warn", "student_resolution_failed", "not_on_roster"],
      ["info", "student_resolution_failed", "not_in_sitting"],
    ]);
    expect(lines[0]).toMatchObject({ sub: "s1", email_ref: emailRef(ADDRESS), email_domain: "edtools.psd401.net" });
    expect(lines[1]!.sitting_id).toBe("x");
  });

  test("the line never carries the address", () => {
    logResolutionFailure({ route: "R", reason: "identity_conflict", session: { sub: "s1", email: ADDRESS } });
    const out = JSON.stringify(lines).toLowerCase();
    expect(out).not.toContain("missing.kid");
  });
});

describe("GET /api/me/sittings", () => {
  test("a student not on the roster leaves one warn line with the route and reason", async () => {
    principal = studentPrincipal(ADDRESS);
    const { GET } = await import("../app/api/me/sittings/route");
    const res = await GET();
    expect(await res.json()).toMatchObject({ sittings: [], reason: "not_on_roster" });
    const hits = lines.filter((l) => l.event === "student_resolution_failed");
    expect(hits).toEqual([
      expect.objectContaining({
        level: "warn",
        route: "GET /api/me/sittings",
        reason: "not_on_roster",
        email_ref: emailRef(ADDRESS),
      }),
    ]);
  });
});
