import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { CreateAssessmentBody } from "@/lib/api/assessments";

export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  const rows = await db
    .select()
    .from(assessments)
    .where(eq(assessments.owner_sub, auth.session.sub))
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
