// The admin grant surface (docs/access-model-design.md, D-1 / D-6), access
// slice 2. Slice 5 gives it a page; this is the API underneath.
//
// Everything a teacher cannot grant on their own assessment lives here:
// `teacher` scope (a substitute covering a colleague, or a principal reading one
// teacher), `school` scope (stored, inert until D-7's slice 6), and `own`.
//
// NOT-FOUND FOR A NON-ADMIN, not forbidden. D-3 made 404 the single access
// refusal so a status code never says "this exists but is not yours", and the
// admin surface is the strongest case for it: a 403 here would tell any teacher
// that an admin API exists and that they are not on the list.
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { notFoundResponse } from "@/lib/api/access";
import { isAdmin } from "@/lib/auth/admin";
import { normalizeEmail } from "@/lib/roster/queries";
import {
  CreateScopedGrantBody,
  GRANT_VALIDATION_STATUS,
  createGrant,
  listGrantsFor,
  listGrantsOnScope,
  validateGrantRequest,
} from "@/lib/api/grants";

/**
 * `?grantee=<email>` — every grant that address holds, live or revoked.
 * `?scope_kind=teacher&scope_id=<email>` — the live grants on one scope.
 * Neither: 400, because "every grant in the district" is a table slice 5 draws
 * with its own pagination rather than a default this route should guess at.
 */
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isAdmin(auth.session)) return notFoundResponse();

  const params = new URL(req.url).searchParams;
  const grantee = normalizeEmail(params.get("grantee"));
  if (grantee) {
    return NextResponse.json({ grants: await listGrantsFor(getDb(), grantee) });
  }
  const scopeKind = params.get("scope_kind");
  const scopeId = params.get("scope_id");
  if (
    scopeId &&
    (scopeKind === "assessment" || scopeKind === "teacher" || scopeKind === "school")
  ) {
    return NextResponse.json({
      grants: await listGrantsOnScope(
        getDb(),
        scopeKind,
        scopeKind === "teacher" ? (normalizeEmail(scopeId) ?? scopeId) : scopeId,
      ),
    });
  }
  return NextResponse.json(
    { ok: false, error: "query_required" },
    { status: 400 },
  );
}

/** Create a grant at any scope and level. Admin only. */
export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isAdmin(auth.session)) return notFoundResponse();

  let body;
  try {
    body = CreateScopedGrantBody.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail },
      { status: 400 },
    );
  }

  const checked = validateGrantRequest({
    granter: auth.session,
    grantee_email: body.grantee_email,
    level: body.level,
  });
  if (!checked.ok) {
    return NextResponse.json(
      { ok: false, error: checked.error },
      { status: GRANT_VALIDATION_STATUS[checked.error] },
    );
  }

  const created = await createGrant(getDb(), {
    grantee_email: checked.grantee_email,
    scope_kind: body.scope_kind,
    scope_id: body.scope_id,
    level: body.level,
    ends_at: body.ends_at ? new Date(body.ends_at) : null,
    note: body.note ?? null,
    granted_by_sub: auth.session.sub,
    granted_by_email: auth.session.email ?? "",
  });
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: created.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true, grant: created.grant }, { status: 201 });
}
