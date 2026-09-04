// Slice 77 (ADR 0017): from verified id_token claims to a session payload.
//
// Both login routes — the browser callback and the client's token exchange —
// end with the same question: given claims Google (or the test issuer) has
// signed, who is this and are they allowed in? Answering it in one place
// means the two routes cannot drift apart on what a valid identity is.
//
// The claims read are the standard OIDC ones: `sub`, `email`,
// `email_verified`, and Google's `hd` (hosted domain). The role is derived
// from the email domain by lib/auth/roles.ts and written into the session; no
// role claim from the token is consulted, because none is trusted.

import type { JWTPayload } from "jose";
import { emailDomain, roleForEmail } from "./roles";
import type { SessionPayload } from "./session";

export type IdentityOutcome =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: "no_sub" | "account_not_allowed" };

/** Google emits a boolean; some IdPs emit the string "true". Accept both,
 * and nothing else. */
function isVerified(value: unknown): boolean {
  return value === true || value === "true";
}

export function sessionFromIdTokenClaims(claims: JWTPayload): IdentityOutcome {
  if (!claims.sub) return { ok: false, reason: "no_sub" };

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;
  const verified = isVerified(claims.email_verified);
  const hd = typeof claims.hd === "string" ? claims.hd.trim().toLowerCase() : undefined;

  const role = roleForEmail(email, verified);
  if (role === "denied") {
    // The domain is the one thing worth logging — it is what the allowlist
    // decides on, and a district rollout will surface a domain we have not
    // listed here first. Never the address.
    console.warn(
      `auth: sign-in refused — domain ${JSON.stringify(emailDomain(email) ?? "(none)")}, ` +
        `email_verified=${verified}`,
    );
    return { ok: false, reason: "account_not_allowed" };
  }

  // `hd` is Google's statement of which Workspace the account belongs to. The
  // allowlist keys on the email domain per ADR 0017; whether `hd` matches it
  // for edtools.psd401.net students (a secondary domain of the psd401.net
  // Workspace, or its own?) is unknown until the first student signs in. Log
  // the disagreement so that first sign-in answers the question.
  if (hd !== undefined && hd !== emailDomain(email)) {
    console.warn(
      `auth: hd claim ${JSON.stringify(hd)} differs from email domain ` +
        `${JSON.stringify(emailDomain(email))} — see ADR 0017 "Depends on" #2`,
    );
  }

  return {
    ok: true,
    payload: { sub: claims.sub, role, email: email!, hd },
  };
}
