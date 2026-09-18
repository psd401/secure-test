import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { CreateAssessmentBody } from "@/lib/api/assessments";
import { normalizeEmail } from "@/lib/roster/queries";
import { visibleAssessments } from "@/lib/api/visibleAssessments";

export async function GET(req?: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  // Archive (docs/archive-and-delete-design.md, D-4): archived rows are hidden
  // by default and `?archived=1` shows ONLY them, so the two lists partition
  // what the caller can see rather than overlapping.
  const wantArchived =
    req !== undefined && new URL(req.url).searchParams.get("archived") === "1";
  // Access slice 2: owned ∪ granted, not `owner_sub` alone. Each row carries
  // `access` so a client can label a row it does not own.
  const rows = await visibleAssessments(db, auth.session, {
    archived: wantArchived,
    orderBy: [desc(assessments.updated_at)],
  });
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
      // Access slice 2: the key a `teacher`-scoped grant resolves through
      // (migration 0038). Written here at create time, as `test_sessions`
      // already did — there is no staff table to map a sub to an address.
      owner_email: normalizeEmail(auth.session.email),
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
