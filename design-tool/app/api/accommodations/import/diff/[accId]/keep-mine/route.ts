import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeStudent } from "@/lib/api/access";

interface RouteContext {
  params: Promise<{ accId: string }>;
}

// UX pass 2 slice 5 (P2-5): persist a "Keep mine" decision. Before this,
// Keep mine was screen-only and the identical next import re-raised the
// same conflict (hand-run 2026-08-31, row 16). Stores the TIDE code the
// teacher decided against; pendingDiffs and the importer treat a row whose
// kept_against_tide_code still matches tide_code as decided. A NEW TIDE
// assertion (different code) no longer matches and the diff returns.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { accId } = await ctx.params;
  if (!UUID_RE.test(accId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  // The row is addressed by its own id, so its student is loaded first and the
  // access question asked about THAT student (access slice 1, D-3) — another
  // teacher's row is a 404 now rather than the old 403.
  const [acc] = await db
    .select()
    .from(student_accommodations)
    .where(
      and(
        eq(student_accommodations.id, accId),
        isNull(student_accommodations.removed_at),
      ),
    )
    .limit(1);
  if (!acc) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const access = await authorizeStudent(db, auth.session, acc.student_id, "own");
  if (!access.ok) return access.response;
  // Only meaningful on a preserved-with-diff row that still knows TIDE's code.
  if (acc.source !== "tide_then_edited" || !acc.tide_code) {
    return NextResponse.json(
      { ok: false, error: "not_a_pending_diff", source: acc.source },
      { status: 409 },
    );
  }

  const [updated] = await db
    .update(student_accommodations)
    .set({ kept_against_tide_code: acc.tide_code })
    .where(eq(student_accommodations.id, acc.id))
    .returning();
  return NextResponse.json({ accommodation: updated });
}
