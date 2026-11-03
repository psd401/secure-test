import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { notFoundResponse } from "@/lib/api/access";
import { JSON_BODY_LIMITS, readJsonBody } from "@/lib/api/jsonBody";
import { GRANT_VALIDATION_STATUS, createGrant, validateGrantRequest } from "@/lib/api/grants";
import { isCompetencyAdmin } from "@/lib/auth/admin";
import { normalizeEmail } from "@/lib/roster/queries";
import { listCounselorGrants, rosterSchools } from "@/lib/competency/counselors";

const AddCounselorBody = z
  .object({
    grantee_email: z.string().trim().min(3).max(320),
    school_id: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * Counselors (docs/competency-assessment-design.md, slice 6, James 6.2): the
 * live counselor grants and the roster's schools to pick from. Assessment
 * staff only; anyone else gets 404, as the admin grant surface does.
 */
export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isCompetencyAdmin(auth.session)) return notFoundResponse();
  const db = getDb();
  const [counselors, schools] = await Promise.all([listCounselorGrants(db), rosterSchools(db)]);
  return NextResponse.json({
    counselors: counselors.map((g) => ({ id: g.id, grantee_email: g.grantee_email, school_id: g.scope_id })),
    schools,
  });
}

/**
 * Add a counselor: a `school`-scoped grant at `view`. It reaches only the
 * counselor results list (lib/competency/counselors.ts) — general access
 * still skips the school scope.
 */
export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!isCompetencyAdmin(auth.session)) return notFoundResponse();
  const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.default);
  if (!bodyRead.ok) return bodyRead.response;
  let raw: unknown = null;
  try {
    raw = bodyRead.parse();
  } catch {
    // Malformed JSON falls through to the schema's refusal below.
  }
  const parsed = AddCounselorBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const valid = validateGrantRequest({
    granter: auth.session,
    grantee_email: parsed.data.grantee_email,
    level: "view",
  });
  if (!valid.ok) {
    return NextResponse.json({ ok: false, error: valid.error }, { status: GRANT_VALIDATION_STATUS[valid.error] });
  }
  const db = getDb();
  if (!(await rosterSchools(db)).some((s) => s.school_id === parsed.data.school_id)) {
    return NextResponse.json({ ok: false, error: "unknown_school" }, { status: 400 });
  }
  const granterEmail = normalizeEmail(auth.session.email);
  if (!granterEmail) return notFoundResponse();
  const created = await createGrant(db, {
    grantee_email: valid.grantee_email,
    scope_kind: "school",
    scope_id: parsed.data.school_id,
    level: "view",
    note: "counselor",
    granted_by_sub: auth.session.sub,
    granted_by_email: granterEmail,
  });
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: created.error }, { status: 409 });
  }
  return NextResponse.json({ grant: { id: created.grant.id } }, { status: 201 });
}
