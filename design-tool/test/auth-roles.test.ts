// Slice 77: role from the email domain. Every outcome the allowlist can
// produce gets a test, and the failure direction is now DENY — there is no
// unknown-means-staff default to reason about any more.
import { describe, expect, test } from "bun:test";
import {
  STAFF_DOMAINS,
  STUDENT_DOMAINS,
  emailDomain,
  isStaff,
  isStudent,
  mapRole,
  roleForEmail,
} from "../lib/auth/roles";

describe("emailDomain", () => {
  test("lowercases and trims", () => {
    expect(emailDomain("  Jane.Doe@PSD401.net ")).toBe("psd401.net");
  });

  test("refuses anything not shaped like exactly one address", () => {
    for (const bad of [
      "",
      "   ",
      "no-at-sign",
      "@psd401.net",
      "jane@",
      "jane@psd401.net@evil.example",
      "jane doe@psd401.net",
      "jane@psd 401.net",
      null,
      undefined,
    ]) {
      expect(emailDomain(bad)).toBeNull();
    }
  });
});

describe("roleForEmail", () => {
  test("the allowlist is exactly the two PSD Workspace domains", () => {
    expect(STAFF_DOMAINS).toEqual(["psd401.net"]);
    expect(STUDENT_DOMAINS).toEqual(["edtools.psd401.net"]);
  });

  test("psd401.net is staff, edtools.psd401.net is student", () => {
    expect(roleForEmail("teacher.one@psd401.net", true)).toBe("staff");
    expect(roleForEmail("ada.fixture@edtools.psd401.net", true)).toBe("student");
  });

  test("case and surrounding whitespace do not matter", () => {
    expect(roleForEmail("  Teacher.One@PSD401.NET ", true)).toBe("staff");
    expect(roleForEmail("Ada@EdTools.PSD401.net", true)).toBe("student");
  });

  test("an unverified address is denied whatever its domain", () => {
    expect(roleForEmail("teacher.one@psd401.net", false)).toBe("denied");
    expect(roleForEmail("ada.fixture@edtools.psd401.net", false)).toBe("denied");
  });

  test("any other domain is denied — no unknown-means-staff default", () => {
    for (const email of [
      "someone@gmail.com",
      "someone@psd401.org",
      "someone@sub.psd401.net",
      "someone@evil-psd401.net",
      "someone@psd401.net.evil.example",
      "someone@notpsd401.net",
      "someone@edtools.psd401.net.evil.example",
    ]) {
      expect(roleForEmail(email, true)).toBe("denied");
    }
  });

  test("a subdomain of the staff domain does not inherit staff", () => {
    // edtools.psd401.net IS a subdomain of psd401.net; the match is exact, so
    // students never become staff by suffix.
    expect(roleForEmail("ada@edtools.psd401.net", true)).not.toBe("staff");
  });

  test("a missing or malformed address is denied", () => {
    for (const bad of ["", "   ", "nope", "x@psd401.net@psd401.net", null, undefined]) {
      expect(roleForEmail(bad, true)).toBe("denied");
    }
  });

  test("a second '@' cannot smuggle an allowlisted domain past the check", () => {
    expect(roleForEmail("attacker@evil.example@psd401.net", true)).toBe("denied");
    expect(roleForEmail("attacker@psd401.net@evil.example", true)).toBe("denied");
  });
});

describe("mapRole (the session's own vocabulary)", () => {
  test("accepts exactly staff and student", () => {
    expect(mapRole("staff")).toBe("staff");
    expect(mapRole("student")).toBe("student");
    expect(mapRole(" Staff ")).toBe("staff");
    expect(isStaff("staff")).toBe(true);
    expect(isStudent("student")).toBe(true);
  });

  test("a pre-slice-77 ClassLink title in a session is denied, not staff", () => {
    for (const legacy of ["teacher", "administrator", "aide", "proctor", "learner", "studentAide"]) {
      expect(mapRole(legacy)).toBe("denied");
      expect(isStaff(legacy)).toBe(false);
      expect(isStudent(legacy)).toBe(false);
    }
  });

  test("family, observer, unknown, empty and absent are all denied", () => {
    for (const raw of ["guardian", "parent", "observer", "vice-principal", "", "   ", null, undefined]) {
      expect(mapRole(raw)).toBe("denied");
    }
  });
});
