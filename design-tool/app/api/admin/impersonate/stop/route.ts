// Stop an act-as (docs/access-model-design.md, D-8), access slice 5.
//
// Gated on the session CARRYING `actor_*`, not on `isAdmin` — by design the
// principal here is the target teacher and `isAdmin` is false for them
// (lib/auth/admin.ts). A session with no actor has nothing to stop and gets
// the same 404 the start route gives, so neither route ever tells a caller
// what it is not.
//
// Redirects rather than answering JSON: Stop is a plain form POST in the
// header banner, which must keep working on a page whose JavaScript failed —
// it is the way out of a session that is not the admin's own. 303 so the
// browser follows it with a GET.
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { notFoundResponse } from "@/lib/api/access";
import { appOrigin } from "@/lib/auth/appOrigin";
import { isImpersonating } from "@/lib/auth/admin";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { log } from "@/lib/log";
import { closeImpersonation } from "@/lib/api/impersonation";
import { mintSessionJWT, sessionCookieAttributes } from "@/lib/auth/session";

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isImpersonating(auth.session)) return notFoundResponse();

  const actorSub = auth.session.actor_sub!;
  const actorEmail = auth.session.actor_email ?? "";
  const targetSub = auth.session.sub;

  await closeImpersonation(getDb(), {
    actor_sub: actorSub,
    target_sub: targetSub,
  });
  log.info("impersonation_stop", {
    sub: targetSub,
    actor_sub: actorSub,
    request_id: (await headers()).get(REQUEST_ID_HEADER) ?? undefined,
  });

  // The admin's own session is MINTED fresh from the actor claims, not
  // restored from anything kept server-side: the act-as cookie is the only
  // record of who the admin is, and it is signed by us, so re-issuing from it
  // is exactly as trustworthy as the cookie itself. `role` is "staff" because
  // that is the only role an admin can have (D-1: admin is a config list, not
  // a role).
  const token = await mintSessionJWT({
    sub: actorSub,
    role: "staff",
    email: actorEmail,
  });
  const cookie = sessionCookieAttributes();
  const res = NextResponse.redirect(
    new URL("/dashboard", appOrigin(req)).toString(),
    { status: 303 },
  );
  res.cookies.set({
    name: cookie.name,
    value: token,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });
  return res;
}
