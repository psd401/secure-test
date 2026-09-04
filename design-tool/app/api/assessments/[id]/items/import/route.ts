import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { itemConfigForWrite } from "@/lib/api/items";
import { parseItemsCsv } from "@/lib/api/importItemsCsv";
import { requireDraft } from "@/lib/api/requireDraft";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  csv: z.string().min(1).max(2_000_000),
  // false (default): preview only, no writes. true: insert the valid rows.
  commit: z.boolean().default(false),
});

// Slice 41: template-driven CSV item import onto a DRAFT assessment.
// commit=false returns the per-row parse report with nothing written;
// commit=true appends the valid rows (invalid rows are skipped and still
// reported — not all-or-nothing). Appends after the current max position,
// so import adds to rather than replaces the existing items.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: String(err) },
      { status: 400 },
    );
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
  const draftGuard = requireDraft(assessment);
  if (draftGuard) return draftGuard;

  const parse = parseItemsCsv(body.csv);
  if (parse.headerError) {
    return NextResponse.json(
      { ok: false, error: "header_error", detail: parse.headerError },
      { status: 400 },
    );
  }

  // Preview: report only, no writes. The per-row `item` is dropped from
  // the response (internal shape); callers get the raw + errors to render.
  const report = {
    valid_count: parse.validCount,
    invalid_count: parse.invalidCount,
    rows: parse.rows.map((r) => ({
      line: r.line,
      type: r.raw.type,
      stem: r.raw.stem,
      valid: r.errors.length === 0,
      errors: r.errors,
    })),
  };

  if (!body.commit) {
    return NextResponse.json({ ok: true, committed: false, ...report });
  }

  const validRows = parse.rows.filter((r) => r.item);
  if (validRows.length === 0) {
    return NextResponse.json({
      ok: true,
      committed: true,
      inserted: 0,
      ...report,
    });
  }

  const inserted = await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ position: items.position })
      .from(items)
      .where(eq(items.assessment_id, id))
      .orderBy(desc(items.position))
      .limit(1);
    let pos = (last?.position ?? -1) + 1;
    const values = validRows.map((r) => {
      const item = r.item!;
      return {
        assessment_id: id,
        position: pos++,
        type: item.type,
        stem: item.stem,
        choices: "choices" in item ? item.choices : [],
        correct_choice_ids:
          "correct_choice_ids" in item ? item.correct_choice_ids : [],
        correct_answer:
          "correct_answer" in item ? (item.correct_answer ?? null) : null,
        config: itemConfigForWrite(item),
      };
    });
    const rows = await tx.insert(items).values(values).returning({ id: items.id });
    await tx
      .update(assessments)
      .set({ updated_at: new Date() })
      .where(and(eq(assessments.id, id)));
    return rows.length;
  });

  return NextResponse.json({
    ok: true,
    committed: true,
    inserted,
    ...report,
  });
}
