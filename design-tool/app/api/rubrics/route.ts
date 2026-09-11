import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rubrics } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { CreateRubricBody, rubricSummary } from "@/lib/api/rubrics";

// Rubric library slice 3 (docs/rubric-upload-design.md §"Rubric library and
// reuse", D-4). Owner-scoped, like /api/students: the list is the caller's
// own rubrics and nothing else, so there is no per-row ownership check to
// forget — the WHERE clause is the authorization.

export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  const rows = await db
    .select()
    .from(rubrics)
    .where(eq(rubrics.owner_sub, auth.session.sub))
    .orderBy(desc(rubrics.updated_at));
  // Summaries, not whole rubrics: the picker shows title / style / criteria
  // count / max points, and GET /api/rubrics/[id] fetches the one the
  // teacher actually applies.
  return NextResponse.json({ rubrics: rows.map(rubricSummary) });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = CreateRubricBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: message },
      { status: 400 },
    );
  }
  const db = getDb();
  const [row] = await db
    .insert(rubrics)
    .values({
      owner_sub: auth.session.sub,
      title: body.title,
      rubric: body.rubric,
      source: body.source,
    })
    .returning();
  return NextResponse.json({ rubric: row }, { status: 201 });
}
