// Slice 58 follow-up (security review, finding 1): the bearer credential path
// had no coverage.
//
// Every other test file mocks `next/headers` with an empty `new Headers()`, so
// readBearerToken() returned null everywhere and the whole bearer branch was
// dead in tests — including the deliberate decision NOT to fall back to the
// cookie when a bearer token is present but bad. A regression that turned that
// refusal into a fallback would have let anyone who sends a junk Authorization
// header be authenticated as whoever holds the cookie, and the full suite would
// still have gone green.
//
// These tests use the REAL session module. Only next/headers is mocked, because
// it is the transport, not the logic.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";
import { closeDb } from "../db/client";
import { SESSION_COOKIE_NAME, mintSessionJWT } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const SECRET = "bearer-test-secret-do-not-use";
let originalSecret: string | undefined;

let mockHeaders = new Headers();
let mockCookie: string | null = null;

mock.module("next/headers", () => ({
  headers: async () => mockHeaders,
  cookies: async () => ({
    get: (name: string) =>
      mockCookie && name === SESSION_COOKIE_NAME ? { value: mockCookie } : undefined,
  }),
}));

// bun's mock.module registry is shared across the whole test RUN, not scoped to
// a file. Seventeen other suites replace readSessionFromCookies with one that
// returns a teacher whenever their own `mockSub` is set, and whichever ran last
// wins — so without pinning it here, "no credentials" quietly inherited another
// file's logged-in teacher and this suite passed alone but failed in the run.
//
// Pinned to the real verification rather than to a canned object, so the cookie
// branch still behaves like the cookie branch. The bearer branch, which is what
// this file exists to cover, is untouched by the mock.
mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => {
    if (!mockCookie) return null;
    try {
      return await sessionMod.verifySessionJWT(mockCookie);
    } catch {
      return null;
    }
  },
}));

beforeAll(() => {
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = SECRET;
});

afterAll(async () => {
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

beforeEach(() => {
  mockHeaders = new Headers();
  mockCookie = null;
});

function bearer(token: string, scheme = "Bearer") {
  mockHeaders = new Headers({ authorization: `${scheme} ${token}` });
}

async function staff() {
  const { requireStaff } = await import("../lib/api/requireSession");
  return requireStaff();
}

async function expiredToken(role: string) {
  return new SignJWT({ sub: "expired-user", role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(1_600_000_000)
    .setIssuer("secure-test/design-tool")
    .setExpirationTime(1_600_000_060)
    .sign(new TextEncoder().encode(SECRET));
}

async function foreignToken(role: string) {
  return new SignJWT({ sub: "foreign-user", role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("secure-test/design-tool")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-completely-different-secret"));
}

describe("bearer authentication", () => {
  test("a validly signed bearer token authenticates with no cookie present", async () => {
    bearer(await mintSessionJWT({ sub: "teacher-1", role: "staff" }));
    const auth = await staff();
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.session.sub).toBe("teacher-1");
  });

  test("the scheme is matched case-insensitively and tolerates padding", async () => {
    const token = await mintSessionJWT({ sub: "teacher-1", role: "staff" });
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      mockHeaders = new Headers({ authorization: `  ${scheme}   ${token}  ` });
      const auth = await staff();
      expect(auth.ok).toBe(true);
    }
  });

  // The load-bearing one. A bad bearer must NOT silently fall through to a
  // valid cookie — that would authenticate an attacker's junk header as whoever
  // holds the session cookie.
  test("a garbage bearer is refused even when a valid cookie is present", async () => {
    mockCookie = await mintSessionJWT({ sub: "teacher-1", role: "staff" });
    bearer("not-a-jwt-at-all");
    const auth = await staff();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });

  test("a token signed with another secret is refused, not thrown as a 500", async () => {
    bearer(await foreignToken("teacher"));
    const auth = await staff();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });

  test("an expired token is refused", async () => {
    bearer(await expiredToken("teacher"));
    const auth = await staff();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });

  test("a well-formed token from a different issuer is refused", async () => {
    const token = await new SignJWT({ sub: "x", role: "staff" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("some-other-app")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    bearer(token);
    const auth = await staff();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });

  test("an Authorization header with a non-bearer scheme is ignored, not refused", async () => {
    // Falls through to the cookie: nothing claimed to be a bearer credential.
    mockCookie = await mintSessionJWT({ sub: "teacher-1", role: "staff" });
    mockHeaders = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    const auth = await staff();
    expect(auth.ok).toBe(true);
  });

  test("the role gate applies to bearer tokens exactly as it does to cookies", async () => {
    bearer(await mintSessionJWT({ sub: "student-1", role: "student" }));
    const auth = await staff();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(403);

    bearer(await mintSessionJWT({ sub: "guardian-1", role: "guardian" }));
    const denied = await staff();
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
  });

  test("requireStudent accepts a student bearer and refuses a teacher one", async () => {
    const { requireStudent } = await import("../lib/api/requireSession");
    bearer(await mintSessionJWT({ sub: "student-1", role: "student" }));
    expect((await requireStudent()).ok).toBe(true);

    bearer(await mintSessionJWT({ sub: "teacher-1", role: "staff" }));
    const refused = await requireStudent();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
  });

  test("the cookie path still works when no Authorization header is sent", async () => {
    mockCookie = await mintSessionJWT({ sub: "teacher-1", role: "staff" });
    const auth = await staff();
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.session.sub).toBe("teacher-1");
  });

  test("neither credential means unauthenticated", async () => {
    const auth = await staff();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });

  // Wiring check: the guard is reached through a real route handler, not only
  // when called directly.
  test("a real route honours a bearer token end to end", async () => {
    const { GET } = await import("../app/api/assessments/route");
    bearer(await mintSessionJWT({ sub: "student-1", role: "student" }));
    const refused = await GET();
    expect(refused.status).toBe(403);

    bearer(await mintSessionJWT({ sub: "bearer-teacher", role: "staff" }));
    const allowed = await GET();
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);
  });
});
