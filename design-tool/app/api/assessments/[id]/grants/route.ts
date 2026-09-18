// Co-teacher grants on ONE assessment (docs/access-model-design.md, D-4 (b)),
// access slice 2. Slice 3 gives the Share dialog its second mode; this is the
// surface underneath it.
//
// `own` throughout: granting access is an owner's act, beside share, archive and
// delete on the note's ladder. An `edit` co-teacher can change the assessment
// but cannot hand it to a third person — which is the point of having a ladder
// rather than a boolean.
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import {
  CreateAssessmentGrantBody,
  GRANT_VALIDATION_STATUS,
  createGrant,
  listGrantsOnScope,
  validateGrantRequest,
} from "@/lib/api/grants";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The live grants on this assessment — who can co-teach it. */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "own");
  if (!access.ok) return access.response;
  return NextResponse.json({
    grants: await listGrantsOnScope(db, "assessment", id),
  });
}

/**
 * Grant a colleague access to this assessment.
 *
 * Scope is fixed to `assessment` and `scope_id` to this id — the body cannot
 * name either, so this route can never write a teacher- or school-scoped grant.
 * Those are the admin surface's (`/api/grants`), because "everything this
 * teacher owns" is a bigger statement than an owner of one assessment is
 * entitled to make.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = CreateAssessmentGrantBody.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail },
      { status: 400 },
    );
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "own");
  if (!access.ok) return access.response;

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

  const created = await createGrant(db, {
    grantee_email: checked.grantee_email,
    scope_kind: "assessment",
    scope_id: id,
    level: body.level,
    ends_at: body.ends_at ? new Date(body.ends_at) : null,
    note: body.note ?? null,
    granted_by_sub: auth.session.sub,
    granted_by_email: auth.session.email ?? "",
  });
  if (!created.ok) {
    // The partial unique index refused it: this colleague already holds a live
    // grant on this assessment. Revoke it and grant again to change the level.
    return NextResponse.json({ ok: false, error: created.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true, grant: created.grant }, { status: 201 });
}
