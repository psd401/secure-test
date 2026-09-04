// Slice 77 (ADR 0017): principal role from the email DOMAIN, never from a
// client-supplied role claim.
//
// Slice 58 mapped a ClassLink `role` claim onto principal types with a
// generous "unknown means staff" default, because the ClassLink vocabulary was
// unverified. That whole problem is gone: identity is now a Google Workspace
// account, and Workspace accounts are partitioned by domain — staff on
// `psd401.net`, students on `edtools.psd401.net`. The domain is asserted by
// Google in a signed id_token, so it is the one fact about a login that the
// caller cannot choose.
//
// Two functions, two inputs, deliberately kept apart:
//
//   roleForEmail(email, verified)  — at LOGIN, from the id_token. Decides
//                                    whether a session is minted at all.
//   mapRole(session.role)          — on every REQUEST, from our own signed
//                                    session JWT, where the role was written
//                                    by roleForEmail. Exact match only; the
//                                    session vocabulary is ours.
//
// Anything not on the allowlist is denied. There is no unknown-means-staff
// default any more: a domain we did not list is not a colleague with an odd
// title, it is somebody else's Google account.

export type PrincipalRole = "student" | "staff" | "denied";

export const STAFF_DOMAINS: readonly string[] = ["psd401.net"];
export const STUDENT_DOMAINS: readonly string[] = ["edtools.psd401.net"];

/**
 * The domain of an address, lowercased — or null when the string is not
 * shaped like one address. Exactly one `@`, both sides non-empty, no
 * whitespace inside: the rest of RFC 5322 is Google's problem, not ours, and
 * a lenient parser here would be a way to smuggle a second domain past the
 * allowlist ("x@psd401.net@evil.example").
 */
export function emailDomain(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return null;
  if (/\s/.test(value)) return null;
  return value.slice(at + 1);
}

/**
 * Role for a login. Requires the address to be VERIFIED by the issuer — Google
 * sets `email_verified` true for Workspace accounts; a token without it is
 * refused rather than trusted, because an unverified address is a string the
 * account holder typed.
 */
export function roleForEmail(
  email: string | null | undefined,
  emailVerified: boolean,
): PrincipalRole {
  if (!emailVerified) return "denied";
  const domain = emailDomain(email);
  if (!domain) return "denied";
  if (STAFF_DOMAINS.includes(domain)) return "staff";
  if (STUDENT_DOMAINS.includes(domain)) return "student";
  return "denied";
}

/**
 * Role for a request, read back from our session JWT. The value was written
 * by `roleForEmail` at login, so only its two positive outcomes are valid;
 * anything else — including a session minted before slice 77 that still
 * carries a ClassLink title — is denied and has to sign in again.
 */
export function mapRole(raw: string | null | undefined): PrincipalRole {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "staff") return "staff";
  if (value === "student") return "student";
  return "denied";
}

export function isStaff(raw: string | null | undefined): boolean {
  return mapRole(raw) === "staff";
}

export function isStudent(raw: string | null | undefined): boolean {
  return mapRole(raw) === "student";
}
