import { NextResponse } from "next/server";
import { getOidcConfig } from "@/lib/auth/discovery";
import { exchangeCode } from "@/lib/auth/oauth";
import {
  PKCE_COOKIE_NAME,
  pkceCookieAttributes,
  verifyPkceCookie,
} from "@/lib/auth/pkceCookie";
import { mintSessionJWT, sessionCookieAttributes } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/safeNext";
import { sessionFromIdTokenClaims } from "@/lib/auth/identity";
import { resolveExpectedAudience, verifyIdToken } from "@/lib/auth/verifyIdToken";
import { appOrigin } from "@/lib/auth/appOrigin";

function buildRedirectUri(req: Request): string {
  const fromEnv = process.env.OIDC_REDIRECT_URI;
  if (fromEnv) return fromEnv;
  return new URL("/api/auth/callback", appOrigin(req)).toString();
}

function loginErrorRedirect(req: Request, error: string) {
  const u = new URL("/login", appOrigin(req));
  u.searchParams.set("error", error);
  const res = NextResponse.redirect(u.toString(), { status: 302 });
  // Clear stale pkce cookie if present.
  res.cookies.set({
    name: PKCE_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const idpError = url.searchParams.get("error");

  if (idpError) {
    return loginErrorRedirect(req, idpError);
  }
  if (!code || !state) {
    return loginErrorRedirect(req, "missing_code_or_state");
  }

  const cookieHeader = req.headers.get("cookie") ?? "";
  const pkceCookieRaw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PKCE_COOKIE_NAME}=`))
    ?.slice(PKCE_COOKIE_NAME.length + 1);
  if (!pkceCookieRaw) {
    return loginErrorRedirect(req, "missing_pkce_cookie");
  }

  let pkce;
  try {
    pkce = await verifyPkceCookie(decodeURIComponent(pkceCookieRaw));
  } catch {
    return loginErrorRedirect(req, "invalid_pkce_cookie");
  }
  if (pkce.state !== state) {
    return loginErrorRedirect(req, "state_mismatch");
  }

  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) {
    return loginErrorRedirect(req, "server_misconfigured");
  }

  let tokens;
  try {
    const config = await getOidcConfig(issuer);
    tokens = await exchangeCode({
      tokenEndpoint: config.token_endpoint,
      code,
      verifier: pkce.verifier,
      redirectUri: buildRedirectUri(req),
      clientId,
      clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token_exchange_failed";
    return loginErrorRedirect(req, `token_exchange_failed:${encodeURIComponent(msg)}`);
  }

  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token, {
      issuer,
      audience: resolveExpectedAudience() ?? clientId,
    });
  } catch (err) {
    // Server-side only: the verifier's reason (bad aud/iss/nonce, expired,
    // key not found) without any token material. The browser still gets the
    // opaque code. Without this line the failure is undiagnosable.
    console.error(
      "auth: id_token verification failed:",
      err instanceof Error ? err.message : String(err),
    );
    return loginErrorRedirect(req, "id_token_invalid");
  }

  // A nonce was sent on the authorize request, so a token that omits it is a
  // failure, not a skip — otherwise the replay binding to the PKCE cookie is
  // trivially bypassed by dropping the claim.
  if (claims.nonce !== pkce.nonce) {
    return loginErrorRedirect(req, "nonce_mismatch");
  }
  // Slice 77: who this is and whether they are allowed in is decided from
  // the verified email domain, in one place shared with /api/auth/exchange.
  const identity = sessionFromIdTokenClaims(claims);
  if (!identity.ok) {
    return loginErrorRedirect(
      req,
      identity.reason === "no_sub" ? "id_token_no_sub" : "account_not_allowed",
    );
  }
  const sessionJwt = await mintSessionJWT(identity.payload);

  // Re-validate at the redirect boundary. The cookie is signed, but this is the
  // call that actually resolves the value against the origin — keep the check
  // where the open redirect would happen.
  const dest = safeNextPath(pkce.next) ?? "/dashboard";
  const res = NextResponse.redirect(
    new URL(dest, appOrigin(req)).toString(),
    { status: 302 },
  );
  const sessionCookie = sessionCookieAttributes();
  res.cookies.set({
    name: sessionCookie.name,
    value: sessionJwt,
    httpOnly: sessionCookie.httpOnly,
    secure: sessionCookie.secure,
    sameSite: sessionCookie.sameSite,
    path: sessionCookie.path,
    maxAge: sessionCookie.maxAge,
  });
  // Clear the pkce cookie.
  const pkceCookie = pkceCookieAttributes();
  res.cookies.set({
    name: pkceCookie.name,
    value: "",
    path: pkceCookie.path,
    maxAge: 0,
  });
  return res;
}
