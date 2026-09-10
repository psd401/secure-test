import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { CreateAssessmentBody } from "@/lib/api/assessments";

export async function GET(req?: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  // Archive (docs/archive-and-delete-design.md, D-4): archived rows are hidden
  // by default and `?archived=1` shows ONLY them, so the two lists partition
  // the teacher's assessments rather than overlapping.
  const wantArchived =
    req !== undefined && new URL(req.url).searchParams.get("archived") === "1";
  const rows = await db
    .select()
    .from(assessments)
    .where(
      and(
        eq(assessments.owner_sub, auth.session.sub),
        wantArchived
          ? isNotNull(assessments.archived_at)
          : isNull(assessments.archived_at),
      ),
    )
    .orderBy(desc(assessments.updated_at));
  return NextResponse.json({ assessments: rows });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = CreateAssessmentBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  const db = getDb();
  const [row] = await db
    .insert(assessments)
    .values({
      owner_sub: auth.session.sub,
      name: body.name,
      description: body.description,
      time_limit_seconds: body.time_limit_seconds ?? null,
      allow_llm_authoring: body.allow_llm_authoring ?? false,
      allow_clipboard: body.allow_clipboard ?? false,
      student_layout: body.student_layout ?? "scroll",
      allowed_accommodations: body.allowed_accommodations,
      construct_altering: body.construct_altering,
    })
    .returning();
  return NextResponse.json({ assessment: row }, { status: 201 });
}
