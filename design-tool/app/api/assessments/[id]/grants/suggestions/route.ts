// Roster co-teacher suggestions for the Share dialog's Co-teach mode
// (docs/access-model-design.md, D-4 (b)), access slice 3.
//
// Read-only, `own` (same level as the grants surface above it — an owner
// deciding who to co-teach with is the same act as granting): a co-teacher
// suggestion is a fact about the OWNER's roster, not the caller's, so a
// non-owner has no business seeing it even at `view`.
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { coTeachersOf } from "@/lib/roster/coTeachers";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

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

  const owner = access.assessment.owner_email;
  const suggestions = owner ? await coTeachersOf(db, owner) : [];
  return NextResponse.json({ suggestions });
}
