// Start an act-as (docs/access-model-design.md, D-8), access slice 5.
//
// NOT-FOUND FOR A NON-ADMIN, the same refusal `/api/grants` gives and for the
// same reason (D-3): a 403 would tell any teacher that an impersonation API
// exists and that they are not on the list. An already-impersonated session
// gets the same 404 for free — `isAdmin` is false while `actor_sub` is set
// (lib/auth/admin.ts), so act-as cannot be chained and there is no second
// check to forget.
//
// The response is JSON rather than a redirect: the caller is a list-row
// button, and the two refusals it must be able to show differently —
// "no_account_rows" (a real teacher with nothing to act on) and everything
// else — are not distinguishable in a redirect.
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { notFoundResponse } from "@/lib/api/access";
import { isAdmin } from "@/lib/auth/admin";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { log } from "@/lib/log";
import {
  checkImpersonationTarget,
  normalizeStaffEmail,
  resolveTargetSub,
  startImpersonation,
} from "@/lib/api/impersonation";
import { mintSessionJWT, sessionCookieAttributes } from "@/lib/auth/session";

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isAdmin(auth.session)) return notFoundResponse();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const requested = normalizeStaffEmail(
    (body as { email?: unknown } | null)?.email,
  );
  const checked = checkImpersonationTarget(requested, auth.session.email);
  if (!checked.ok) {
    // Every refusal but a malformed body is a 404: "that is not a staff
    // address" and "that is you" are both statements about a principal the
    // caller named, and neither is worth a distinct status code.
    if (checked.error === "invalid_body") {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: checked.error }, { status: 404 });
  }

  const db = getDb();
  const targetSub = await resolveTargetSub(db, checked.email);
  if (!targetSub) {
    return NextResponse.json(
      { ok: false, error: "no_account_rows" },
      { status: 404 },
    );
  }

  const requestId = (await headers()).get(REQUEST_ID_HEADER);
  const actorSub = auth.session.sub;
  const actorEmail = auth.session.email ?? "";
  await startImpersonation(db, {
    actor_sub: actorSub,
    actor_email: actorEmail,
    target_sub: targetSub,
    target_email: checked.email,
    request_id: requestId,
  });
  log.info("impersonation_start", {
    sub: targetSub,
    actor_sub: actorSub,
    request_id: requestId ?? undefined,
  });

  // The new cookie carries the TARGET as the principal and the admin as the
  // actor. Same 8 h TTL as any other session: an act-as is not more
  // trustworthy than a sign-in, and a shorter life would expire mid-task into
  // a login screen rather than back into the admin's own account.
  const token = await mintSessionJWT({
    sub: targetSub,
    role: "staff",
    email: checked.email,
    actor_sub: actorSub,
    actor_email: actorEmail,
  });
  const cookie = sessionCookieAttributes();
  const res = NextResponse.json({ ok: true, email: checked.email });
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
