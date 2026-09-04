import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const PKCE_COOKIE_NAME = "secure-test-pkce";
const PKCE_TTL_SECONDS = 10 * 60;

export interface PkceCookiePayload extends JWTPayload {
  verifier: string;
  state: string;
  nonce: string;
  next?: string;
}

function getSecret(): Uint8Array {
  // `||`, not `??`: an empty `DESIGN_TOOL_PKCE_SECRET=` line in .env.local is
  // a defined empty string, and must fall back the same way a missing one
  // does (matches the delivery-secret fallback in lib/api/opaqueIds.ts).
  const raw = process.env.DESIGN_TOOL_PKCE_SECRET
    || process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!raw) {
    throw new Error(
      "DESIGN_TOOL_PKCE_SECRET (or DESIGN_TOOL_SESSION_SECRET) is not set",
    );
  }
  return new TextEncoder().encode(raw);
}

export async function mintPkceCookie(
  payload: PkceCookiePayload,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("secure-test/design-tool/pkce")
    .setExpirationTime(`${PKCE_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyPkceCookie(
  token: string,
): Promise<PkceCookiePayload> {
  const { payload } = await jwtVerify<PkceCookiePayload>(token, getSecret(), {
    issuer: "secure-test/design-tool/pkce",
  });
  return payload;
}

export function pkceCookieAttributes() {
  return {
    name: PKCE_COOKIE_NAME,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: PKCE_TTL_SECONDS,
  };
}
