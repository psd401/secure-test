// Slice 77: id_token claims → session payload, the logic both login routes
// share. Pure; the routes' own tests cover transport.
import { describe, expect, test } from "bun:test";
import { sessionFromIdTokenClaims } from "../lib/auth/identity";

function quiet<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("sessionFromIdTokenClaims", () => {
  test("a verified staff address becomes a staff session carrying the email", () => {
    const out = sessionFromIdTokenClaims({
      sub: "g-123",
      email: "Teacher.One@psd401.net",
      email_verified: true,
      hd: "psd401.net",
    });
    expect(out).toEqual({
      ok: true,
      payload: { sub: "g-123", role: "staff", email: "teacher.one@psd401.net", hd: "psd401.net" },
    });
  });

  test("a verified student address becomes a student session", () => {
    const out = sessionFromIdTokenClaims({
      sub: "g-456",
      email: "ada.fixture@edtools.psd401.net",
      email_verified: true,
      hd: "edtools.psd401.net",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.role).toBe("student");
  });

  test("the ClassLink role claim, if a token still carries one, is ignored", () => {
    const out = sessionFromIdTokenClaims({
      sub: "g-789",
      email: "ada.fixture@edtools.psd401.net",
      email_verified: true,
      classLink_role: "administrator",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.role).toBe("student");
  });

  test("email_verified false, absent, or a non-'true' string → account_not_allowed", () => {
    for (const verified of [false, undefined, "false", "yes", 1]) {
      const { value } = quiet(() =>
        sessionFromIdTokenClaims({
          sub: "g-1",
          email: "teacher.one@psd401.net",
          email_verified: verified,
        }),
      );
      expect(value).toEqual({ ok: false, reason: "account_not_allowed" });
    }
  });

  test("the string 'true' is accepted for issuers that emit it that way", () => {
    const out = sessionFromIdTokenClaims({
      sub: "g-1",
      email: "teacher.one@psd401.net",
      email_verified: "true",
    });
    expect(out.ok).toBe(true);
  });

  test("a domain outside the allowlist → account_not_allowed, logged by domain only", () => {
    const { value, warnings } = quiet(() =>
      sessionFromIdTokenClaims({
        sub: "g-1",
        email: "somebody@gmail.com",
        email_verified: true,
      }),
    );
    expect(value).toEqual({ ok: false, reason: "account_not_allowed" });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('"gmail.com"');
    expect(warnings[0]).not.toContain("somebody@");
  });

  test("no email at all → account_not_allowed", () => {
    const { value } = quiet(() => sessionFromIdTokenClaims({ sub: "g-1", email_verified: true }));
    expect(value).toEqual({ ok: false, reason: "account_not_allowed" });
  });

  test("no sub → no_sub, checked before anything else", () => {
    expect(
      sessionFromIdTokenClaims({ email: "teacher.one@psd401.net", email_verified: true }),
    ).toEqual({ ok: false, reason: "no_sub" });
  });

  test("an hd that disagrees with the email domain is allowed but warned about", () => {
    const { value, warnings } = quiet(() =>
      sessionFromIdTokenClaims({
        sub: "g-1",
        email: "ada.fixture@edtools.psd401.net",
        email_verified: true,
        hd: "psd401.net",
      }),
    );
    expect(value.ok).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("hd claim");
  });

  test("a missing hd is fine and produces no warning", () => {
    const { value, warnings } = quiet(() =>
      sessionFromIdTokenClaims({
        sub: "g-1",
        email: "teacher.one@psd401.net",
        email_verified: true,
      }),
    );
    expect(value.ok).toBe(true);
    if (value.ok) expect(value.payload.hd).toBeUndefined();
    expect(warnings.length).toBe(0);
  });
});
