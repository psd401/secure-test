// isUniqueViolation cause-walk (extracted from lib/api/grants.ts /
// lib/api/testSessions.ts / app/api/attempts/route.ts, which each carried
// their own copy — testSessions.ts's copy read `err.code` off the top level
// only and so never recognised a real sitting-code collision, because
// Drizzle wraps the driver error in `DrizzleQueryError` and the SQLSTATE
// sits on `.cause`, not on the wrapper itself).
import { describe, expect, test } from "bun:test";
import { isUniqueViolation } from "../lib/db/isUniqueViolation";

describe("isUniqueViolation", () => {
  test("a bare postgres.js error with code on top", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  test("a DrizzleQueryError-shaped wrapper with the SQLSTATE on .cause", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  test("walks a few levels of nested .cause", () => {
    expect(isUniqueViolation({ cause: { cause: { cause: { code: "23505" } } } })).toBe(true);
  });

  test("a different SQLSTATE is not a unique violation", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
  });

  test("non-error and empty values", () => {
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
  });

  test("gives up past the depth bound rather than looping forever", () => {
    const deep = { cause: { cause: { cause: { cause: { cause: { code: "23505" } } } } } };
    expect(isUniqueViolation(deep)).toBe(false);
  });
});
