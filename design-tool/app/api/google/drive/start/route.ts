import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { appOrigin } from "@/lib/auth/appOrigin";
import { generatePkcePair, generateRandomToken } from "@/lib/auth/pkce";
import { safeNextPath } from "@/lib/auth/safeNext";
import {
  buildDriveAuthorizeUrl,
  driveRedirectUri,
  driveStateCookieAttributes,
  mintDriveStateCookie,
} from "@/lib/googleDocs/driveAuth";

// Row GD slice 2 (docs/google-docs-release-design.md, R-1): sends the teacher
// to Google for the `drive.file` scope and nothing else. The callback returns
// them to `next` with `?gdrive=<outcome>`.

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { session } = auth;

  // An act-as session must never grant Drive "as" the teacher: the Google
  // account at the consent screen would be the admin's own.
  if (session.actor_sub) {
    return NextResponse.json({ ok: false, error: "not_while_acting_as" }, { status: 403 });
  }
  if (!session.email) {
    return NextResponse.json({ ok: false, error: "no_email_on_session" }, { status: 400 });
  }
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ ok: false, error: "OIDC_CLIENT_ID must be set" }, { status: 500 });
  }

  const next = safeNextPath(new URL(req.url).searchParams.get("next")) ?? "/dashboard";
  const { verifier, challenge } = generatePkcePair();
  const state = generateRandomToken();
  const stateCookie = await mintDriveStateCookie({ verifier, state, sub: session.sub, next });

  const res = NextResponse.redirect(
    buildDriveAuthorizeUrl({
      clientId,
      redirectUri: driveRedirectUri(appOrigin(req)),
      state,
      challenge,
      loginHint: session.email,
    }),
    { status: 302 },
  );
  res.cookies.set({ ...driveStateCookieAttributes(), value: stateCookie });
  return res;
}
