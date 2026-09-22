// `lib/auth/admin.ts` — the admin predicate and, from access slice 5, the
// act-as one.
//
// The rule worth its own file: an IMPERSONATED session is never an admin
// (D-8). It is what makes act-as a strict narrowing rather than a widening —
// without it an admin acting as a teacher would still see the admin surface,
// could chain a second impersonation, and would resolve `own` on every row in
// the district while the banner said they were one teacher.
import { afterEach, describe, expect, test } from "bun:test";
import { adminEmails, isAdmin, isImpersonating } from "../lib/auth/admin";

const ADMIN_EMAIL = "sysadmin@psd401.net";
const TEACHER_EMAIL = "lead@psd401.net";

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

describe("isAdmin", () => {
  test("nobody is an admin when the list is unset", () => {
    expect(adminEmails()).toEqual([]);
    expect(isAdmin({ email: ADMIN_EMAIL })).toBe(false);
  });

  test("a listed address is an admin, case- and space-insensitively", () => {
    process.env.ADMIN_EMAILS = `  ${ADMIN_EMAIL.toUpperCase()} , `;
    expect(isAdmin({ email: ADMIN_EMAIL })).toBe(true);
    expect(isAdmin({ email: TEACHER_EMAIL })).toBe(false);
  });

  test("a session with no email is never an admin", () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    expect(isAdmin({})).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  test("an impersonated session is NOT an admin, even as the admin's own address", () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    // The pathological shape: `email` is on the list AND `actor_sub` is set.
    // It cannot arise from the impersonate route (it refuses `self`), and the
    // predicate must still say no — `actor_sub` is the decision, not the
    // address.
    expect(isAdmin({ email: ADMIN_EMAIL, actor_sub: "admin-sub" })).toBe(false);
    // The ordinary shape: acting as a teacher.
    expect(isAdmin({ email: TEACHER_EMAIL, actor_sub: "admin-sub" })).toBe(false);
  });

  test("an empty actor_sub is not impersonation", () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    expect(isAdmin({ email: ADMIN_EMAIL, actor_sub: "" })).toBe(true);
  });
});

describe("isImpersonating", () => {
  test("true only when actor_sub is a non-empty string", () => {
    expect(isImpersonating({ actor_sub: "admin-sub" })).toBe(true);
    expect(isImpersonating({ actor_sub: "" })).toBe(false);
    expect(isImpersonating({})).toBe(false);
    expect(isImpersonating(null)).toBe(false);
    expect(isImpersonating(undefined)).toBe(false);
  });
});
