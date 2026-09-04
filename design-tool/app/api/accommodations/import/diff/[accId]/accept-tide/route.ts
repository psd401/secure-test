import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { mapCatalogIdToTide } from "@/lib/accommodations/tideCatalog";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ accId: string }>;
}

// Accept TIDE's value for one preserved-with-diff row. Mutates the row
// back to `source = tide_import` with TIDE's value + tide_code, and
// clears `edited_at`. Powers the dedicated diff review screen.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { accId } = await ctx.params;
  if (!UUID_RE.test(accId)) {
    return NextResponse.json(
      { ok: false, error: "invalid_id" },
      { status: 400 },
    );
  }

  const db = getDb();
  // Load row + student to verify ownership.
  const [joined] = await db
    .select({
      acc: student_accommodations,
      owner_sub: students.owner_sub,
    })
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

  // Only meaningful on tide_then_edited rows.
  if (joined.acc.source !== "tide_then_edited") {
    return NextResponse.json(
      { ok: false, error: "not_a_pending_diff", source: joined.acc.source },
      { status: 409 },
    );
  }

  // The current `value` is the kept (edited) value; the client tells us which
  // TIDE value to accept. That value is then re-derived from the catalog
  // below — the client is trusted to *choose*, never to *define*, TIDE truth.
  let body: { tide_value?: string } = {};
  try {
    const text = await _req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // Empty body is OK — we just won't have a tide_value to apply.
  }
  if (!body.tide_value) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_tide_value",
        hint: "POST { tide_value: '...' } from the diff review screen.",
      },
      { status: 400 },
    );
  }
  // D13: this validation used to be a knowing no-op — `mapTideToCatalogId`
  // was called with an empty tool name (so it ALWAYS returned null) and the
  // result was discarded via `void mapped`. Any string the client sent was
  // then stored with `source` flipped to the canonical `tide_import` and
  // `tide_code` left pointing at the OLD value. Since DiffReviewPanel makes
  // the teacher hand-type the value, a typo became "TIDE truth" in the audit
  // ledger — and the row would then be overwritten against a stale code on the
  // next import.
  //
  // The row stores `tool_id`, not the TIDE "Tool Name" label, which is why the
  // forward lookup could not be used. `mapCatalogIdToTide` is the inverse index
  // over the same catalog and closes that gap.
  const mapped = mapCatalogIdToTide(
    joined.acc.subject,
    joined.acc.tool_id,
    body.tide_value,
  );
  if (!mapped) {
    return NextResponse.json(
      {
        ok: false,
        error: "tide_value_not_in_catalog",
        subject: joined.acc.subject,
        tool_id: joined.acc.tool_id,
        tide_value: body.tide_value,
        hint: "The value must be one this (subject, tool) actually offers in the TIDE catalog.",
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(student_accommodations)
    .set({
      // Store the catalog's canonical value + its matching code, not the
      // client's string — otherwise tide_code drifts away from `value`.
      value: mapped.value,
      tide_code: mapped.tide_code,
      source: "tide_import",
      edited_at: null,
      kept_against_tide_code: null,
      last_imported_at: now,
    })
    .where(eq(student_accommodations.id, joined.acc.id))
    .returning();
  return NextResponse.json({ accommodation: updated });
}
