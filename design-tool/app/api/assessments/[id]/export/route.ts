import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { buildExportBundle } from "@/lib/api/exportBundle";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * One bundle format serves two audiences: the student client that will
 * eventually render the assessment, and teacher-to-teacher share/backup via
 * POST /api/assessments/import.
 *
 * Rubrics the teacher marked hidden (`student_visibility.during_test` false)
 * must never reach the student — level descriptors routinely spell out what a
 * correct answer contains (phase-1-2 review, B8). But dropping them
 * unconditionally would silently lose authoring data on a share, and import
 * clamps `ai`/`hybrid` scoring when no rubric arrives, so the receiving copy
 * would also be scored differently.
 *
 * So: hidden rubrics are omitted BY DEFAULT — any future delivery path that
 * calls this route is fail-safe without knowing about the flag — and the
 * teacher's own "Export JSON" affordance opts in for a lossless copy.
 */
const INCLUDE_HIDDEN_RUBRICS_PARAM = "include_hidden_rubrics";

export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const includeHiddenRubrics =
    new URL(req.url).searchParams.get(INCLUDE_HIDDEN_RUBRICS_PARAM) === "1";
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const [assessmentRow] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessmentRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (assessmentRow.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Slice C: the bundle assembly lives in lib/api/exportBundle so sharing
  // can reuse it; the failure shapes below are byte-identical to before.
  const built = await buildExportBundle(db, assessmentRow, auth.session.sub, includeHiddenRubrics);
  if (!built.ok) {
    const { status, ...failure } = built;
    return NextResponse.json(failure, { status });
  }
  const validated = built.bundle;
  const bundledCount = built.bundledCount;

  const filename = `${assessmentRow.name.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`;
  return new NextResponse(JSON.stringify(validated, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-skipped-items": "0",
      "x-bundled-asset-count": String(bundledCount),
    },
  });
}
