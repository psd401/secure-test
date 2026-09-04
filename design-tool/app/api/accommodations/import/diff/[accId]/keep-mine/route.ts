import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

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
  const [joined] = await db
    .select({ acc: student_accommodations, owner_sub: students.owner_sub })
    .from(student_accommodations)
    .innerJoin(students, eq(student_accommodations.student_id, students.id))
    .where(
      and(
        eq(student_accommodations.id, accId),
        isNull(student_accommodations.removed_at),
      ),
    )
    .limit(1);
  if (!joined) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (joined.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // Only meaningful on a preserved-with-diff row that still knows TIDE's code.
  if (joined.acc.source !== "tide_then_edited" || !joined.acc.tide_code) {
    return NextResponse.json(
      { ok: false, error: "not_a_pending_diff", source: joined.acc.source },
      { status: 409 },
    );
  }

  const [updated] = await db
    .update(student_accommodations)
    .set({ kept_against_tide_code: joined.acc.tide_code })
    .where(eq(student_accommodations.id, joined.acc.id))
    .returning();
  return NextResponse.json({ accommodation: updated });
}
