import { NextResponse } from "next/server";
import { headers } from "next/headers";
import {
  readSessionFromCookies,
  verifySessionJWT,
  type SessionPayload,
} from "@/lib/auth/session";
import { mapRole, type PrincipalRole } from "@/lib/auth/roles";

export type SessionOrResponse =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse };

/**
 * Slice 58: reads the session from either an `Authorization: Bearer` header or
 * the session cookie.
 *
 * Bearer is checked first and exists for the native macOS client, which has no
 * browser cookie jar and should not be made to emulate one. The cookie remains
 * the web dashboard's mechanism. Both carry the same HS256 session JWT — one
 * token type, two transports, so there is a single place where a session is
 * minted and a single place where it is verified.
 */
async function readSession(): Promise<SessionPayload | null> {
  const bearer = await readBearerToken();
  if (bearer) {
    try {
      return await verifySessionJWT(bearer);
    } catch {
      // A malformed or expired bearer token is not a reason to fall through to
      // the cookie: the caller told us which credential to use, and silently
      // authenticating them as somebody else would be worse than refusing.
      return null;
    }
  }
  return readSessionFromCookies();
}

async function readBearerToken(): Promise<string | null> {
  const store = await headers();
  const raw = store.get("authorization") ?? store.get("Authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

function unauthenticated(): NextResponse {
  return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
}

function forbidden(): NextResponse {
  return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
}

/**
 * Any authenticated principal, whatever its role. Prefer `requireStaff` or
 * `requireStudent`: a route that genuinely serves both is rare, and reaching for
 * this one by default is how the role check gets skipped.
 */
export async function requireSession(): Promise<SessionOrResponse> {
  const session = await readSession();
  if (!session) return { ok: false, response: unauthenticated() };
  return { ok: true, session };
}

async function requireRole(expected: PrincipalRole): Promise<SessionOrResponse> {
  const session = await readSession();
  if (!session) return { ok: false, response: unauthenticated() };
  if (mapRole(session.role) !== expected) {
    // 403 rather than 401: the credential is valid, the principal is simply not
    // permitted here. Returning 401 would invite a client to re-authenticate in
    // a loop it can never win.
    return { ok: false, response: forbidden() };
  }
  return { ok: true, session };
}

/**
 * Teacher-facing surfaces. Ownership is still checked separately by every
 * caller — this only answers whether the principal is the right KIND, which
 * `owner_sub === session.sub` never did.
 */
export async function requireStaff(): Promise<SessionOrResponse> {
  return requireRole("staff");
}

/** Student-facing surfaces (delivery, attempts, responses — Group C). */
export async function requireStudent(): Promise<SessionOrResponse> {
  return requireRole("student");
}
