import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { buildResults, resultsToCsv } from "@/lib/scoring/results";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Slice 40: results matrix (JSON) and the generic CSV export
// (?format=csv). Finals only — proposals are pending, not results.
export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessment) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (assessment.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const results = await buildResults(id, auth.session.sub, auth.session.email);

  const format = new URL(req.url).searchParams.get("format");
  if (format === "csv") {
    const csv = resultsToCsv(results);
    // Sanitized filename: keep it simple and cross-platform.
    const safeName =
      assessment.name.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "assessment";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName} results.csv"`,
      },
    });
  }

  return NextResponse.json({ results });
}
