import { NextResponse } from "next/server";
import { getOidcConfig } from "@/lib/auth/discovery";
import { generatePkcePair, generateRandomToken } from "@/lib/auth/pkce";
import {
  mintPkceCookie,
  pkceCookieAttributes,
} from "@/lib/auth/pkceCookie";
import { safeNextPath } from "@/lib/auth/safeNext";

function buildRedirectUri(req: Request): string {
  const fromEnv = process.env.OIDC_REDIRECT_URI;
  if (fromEnv) return fromEnv;
  const u = new URL(req.url);
  return new URL("/api/auth/callback", u.origin).toString();
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) {
    return NextResponse.json(
      { ok: false, error: "OIDC_ISSUER and OIDC_CLIENT_ID must be set" },
      { status: 500 },
    );
  }

  let config;
  try {
    config = await getOidcConfig(issuer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "discovery failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }

  const { verifier, challenge } = generatePkcePair();
  const state = generateRandomToken();
  const nonce = generateRandomToken();

  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get("next"));

  const cookieValue = await mintPkceCookie({
    verifier,
    state,
    nonce,
    next,
  });

  const redirectUri = buildRedirectUri(req);
  const authorize = new URL(config.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", process.env.OIDC_SCOPES ?? "openid profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(authorize.toString(), { status: 302 });
  const cookie = pkceCookieAttributes();
  res.cookies.set({
    name: cookie.name,
    value: cookieValue,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });
  return res;
}
