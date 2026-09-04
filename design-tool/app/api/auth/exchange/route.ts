import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveExpectedAudience, verifyIdToken } from "@/lib/auth/verifyIdToken";
import { sessionFromIdTokenClaims } from "@/lib/auth/identity";
import { mintSessionJWT, sessionCookieAttributes } from "@/lib/auth/session";

const ExchangeBody = z.object({
  id_token: z.string().min(1),
  // Optional per-request overrides honored only when ALLOW_TEST_ISSUER=1
  // (server-only var; never NEXT_PUBLIC_*, which ships to the client bundle).
  test_issuer: z.string().url().optional(),
  test_jwks: z.unknown().optional(),
});

/**
 * The test-issuer escape hatch lets the caller name its own issuer + JWKS, i.e.
 * mint a session for any `sub` with a self-signed token. It must never be
 * reachable in a deployed build, so it is gated on a server-only var AND hard
 * fails when NODE_ENV=production regardless of how that var is set.
 */
function testIssuerAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ALLOW_TEST_ISSUER === "1";
}

export async function POST(req: Request) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_TEST_ISSUER === "1"
  ) {
    return NextResponse.json(
      { ok: false, error: "ALLOW_TEST_ISSUER must not be set in production" },
      { status: 500 },
    );
  }

  let parsed;
  try {
    parsed = ExchangeBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid request body" },
      { status: 400 },
    );
  }

  const allowTestIssuer = testIssuerAllowed();
  const issuer = allowTestIssuer && parsed.test_issuer
    ? parsed.test_issuer
    : process.env.OIDC_ISSUER;
  if (!issuer) {
    return NextResponse.json(
      { ok: false, error: "OIDC_ISSUER not configured" },
      { status: 500 },
    );
  }

  // Mirror the callback route: never leave `audience` undefined, or jose skips
  // the aud check and a token minted for another client at the same issuer
  // becomes a valid session.
  const audience = resolveExpectedAudience();
  if (!audience) {
    return NextResponse.json(
      { ok: false, error: "OIDC_AUDIENCE or OIDC_CLIENT_ID must be set" },
      { status: 500 },
    );
  }

  let claims;
  try {
    claims = await verifyIdToken(parsed.id_token, {
      issuer,
      audience,
      jwks: allowTestIssuer && parsed.test_jwks
        ? (parsed.test_jwks as Parameters<typeof verifyIdToken>[1]["jwks"])
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification failed";
    return NextResponse.json({ ok: false, error: message }, { status: 401 });
  }

  // Slice 77: same decision as the browser callback, same code. The token
  // verified, so a refusal here is about the ACCOUNT — wrong domain or an
  // unverified address — and gets a 403 the client can show as such, not a
  // 401 that would invite re-authentication in a loop it cannot win.
  const identity = sessionFromIdTokenClaims(claims);
  if (!identity.ok) {
    if (identity.reason === "no_sub") {
      return NextResponse.json(
        { ok: false, error: "id_token has no sub claim" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "account_not_allowed" },
      { status: 403 },
    );
  }
  const sessionPayload = identity.payload;

  const sessionJwt = await mintSessionJWT(sessionPayload);
  const cookie = sessionCookieAttributes();

  // The client stores the JWT in its Keychain and sends it as a bearer token
  // (slice 58); the cookie below serves the browser transport.
  const res = NextResponse.json({
    ok: true,
    sub: sessionPayload.sub,
    role: sessionPayload.role,
    email: sessionPayload.email,
    session_token: sessionJwt,
  });
  res.cookies.set({
    name: cookie.name,
    value: sessionJwt,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });
  return res;
}
