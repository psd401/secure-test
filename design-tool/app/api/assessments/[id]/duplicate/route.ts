import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { duplicateAssessment } from "@/lib/api/duplicateAssessment";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";
import { normalizeEmail } from "@/lib/roster/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Duplicate an assessment into a new Draft owned by the same teacher.
 *
 * Owner-only, and a row owned by someone else answers 404 rather than 403:
 * unlike GET /export there is nothing here a non-owner is ever allowed to
 * learn, not even that the id exists.
 *
 * Allowed on Draft, Published and archived sources — the operation only reads
 * the source, so there is no state it could damage.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "own");
  if (!access.ok) return access.response;
  const result = await duplicateAssessment(
    db,
    access.assessment,
    auth.session.sub,
    // Access slice 2: the copy is the caller's, so it carries the caller's
    // email — not the source's.
    normalizeEmail(auth.session.email),
  );
  if (!result.ok) {
    const { ok, status, ...failure } = result;
    return NextResponse.json({ ok, ...failure }, { status });
  }
  return NextResponse.json(
    { ok: true, assessment_id: result.assessment_id, name: result.name },
    { status: 201 },
  );
}
