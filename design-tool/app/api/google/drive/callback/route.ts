import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { appOrigin } from "@/lib/auth/appOrigin";
import { safeNextPath } from "@/lib/auth/safeNext";
import { log } from "@/lib/log";
import {
  DRIVE_STATE_COOKIE_NAME,
  cookieFromHeader,
  driveAccountEmail,
  driveRedirectUri,
  driveStateCookieAttributes,
  driveTokenCookieAttributes,
  driveTokenLifetimeSeconds,
  exchangeDriveCode,
  grantedScopeIsExactlyDriveFile,
  mintDriveTokenCookie,
  returnUrl,
  sameEmail,
  verifyDriveStateCookie,
  type DriveAuthOutcome,
  type DriveStatePayload,
} from "@/lib/googleDocs/driveAuth";

// Row GD slice 2 (docs/google-docs-release-design.md, R-1 + GD-P1): Google
// returns here. Every outcome is a redirect back to the page that asked, with
// `?gdrive=<outcome>`; only `ok` sets the token cookie.

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { session } = auth;
  if (session.actor_sub) {
    return NextResponse.json({ ok: false, error: "not_while_acting_as" }, { status: 403 });
  }

  const origin = appOrigin(req);
  const url = new URL(req.url);

  let pkce: DriveStatePayload | null = null;
  const raw = cookieFromHeader(req.headers.get("cookie"), DRIVE_STATE_COOKIE_NAME);
  if (raw) {
    try {
      pkce = await verifyDriveStateCookie(raw);
    } catch {
      pkce = null;
    }
  }
  const next = safeNextPath(pkce?.next) ?? "/dashboard";

  const finish = (outcome: DriveAuthOutcome) => {
    if (outcome !== "ok") {
      log.warn("gdrive_auth_failed", { outcome, sub: session.sub });
    }
    const res = NextResponse.redirect(returnUrl(next, origin, outcome), { status: 302 });
    const stateCookie = driveStateCookieAttributes();
    res.cookies.set({ name: stateCookie.name, value: "", path: stateCookie.path, maxAge: 0 });
    return res;
  };

  if (!pkce) return finish("expired");
  if (pkce.sub !== session.sub) return finish("state_mismatch");
  if (url.searchParams.get("error")) return finish("denied");
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== pkce.state) return finish("state_mismatch");

  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) return finish("exchange_failed");

  let token;
  try {
    token = await exchangeDriveCode({
      code,
      verifier: pkce.verifier,
      redirectUri: driveRedirectUri(origin),
      clientId,
      clientSecret,
    });
  } catch (err) {
    log.warn("gdrive_token_exchange_failed", {
      sub: session.sub,
      reason: err instanceof Error ? err.message : String(err),
    });
    return finish("exchange_failed");
  }
  if (!grantedScopeIsExactlyDriveFile(token.scope)) return finish("scope_mismatch");

  const account = await driveAccountEmail(token.access_token);
  if (!account || !session.email || !sameEmail(account, session.email)) {
    return finish("wrong_account");
  }

  const lifetime = driveTokenLifetimeSeconds(token.expires_in);
  const res = finish("ok");
  res.cookies.set({
    ...driveTokenCookieAttributes(lifetime),
    value: await mintDriveTokenCookie(token.access_token, session.sub, lifetime),
  });
  return res;
}
