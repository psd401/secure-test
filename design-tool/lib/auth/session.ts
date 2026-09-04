import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "secure-test-session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export interface SessionPayload extends JWTPayload {
  sub: string;
  /** "staff" | "student", written by roleForEmail at login (slice 77). Read
   * back through mapRole; never taken from the caller. */
  role?: string;
  /** Verified, lowercased Google Workspace address (slice 77). The join key
   * to roster_students.email / roster_section_teachers.teacher_email. */
  email?: string;
  /** Google's hosted-domain claim, kept for the first-sign-in diagnostics. */
  hd?: string;
}

function getSecret(): Uint8Array {
  const raw = process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!raw) {
    throw new Error("DESIGN_TOOL_SESSION_SECRET is not set");
  }
  return new TextEncoder().encode(raw);
}

export async function mintSessionJWT(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("secure-test/design-tool")
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionJWT(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify<SessionPayload>(token, getSecret(), {
    issuer: "secure-test/design-tool",
  });
  return payload;
}

export async function readSessionFromCookies(): Promise<SessionPayload | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  try {
    return await verifySessionJWT(value);
  } catch {
    return null;
  }
}

export function sessionCookieAttributes() {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * Slice 58: cookie session, but only for a staff principal.
 *
 * Server components and server actions branch on a null session already, so
 * swapping this in gives them a role check with no new control flow: a student
 * or a denied principal simply reads as "no session" and gets the existing
 * signed-out treatment.
 *
 * The dashboard is also gated at the edge by proxy.ts. This is the second layer
 * — the proxy's matcher governs which paths it runs on, and a matcher is easy
 * to narrow by accident. Server actions in particular do not reliably inherit
 * the page's matcher, so for those this is the only check.
 */
export async function readStaffSessionFromCookies(): Promise<SessionPayload | null> {
  const session = await readSessionFromCookies();
  if (!session) return null;
  const { isStaff } = await import("./roles");
  return isStaff(session.role) ? session : null;
}
