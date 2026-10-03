import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { class_insight_reports, items, type ClassInsightReportRow } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { getProvider } from "@/lib/ai/provider";
import { buildEvidencePack } from "@/lib/insights/evidencePack";
import {
  REPORT_SECTIONS,
  fillReport,
  reportText,
  type ClassInsightsReport,
} from "@/lib/insights/report";
import { CLASS_INSIGHTS_PROMPT_VERSION } from "@/lib/insights/reportPrompt";
import { normalizeSection, renderReport, sectionKey } from "@/lib/insights/reportView";
import { runGuarded } from "@/lib/safeguarding/guard";
import { buildResults, type AssessmentResults } from "@/lib/scoring/results";
import { lookupTags } from "@/lib/standards/search";
import { UUID_RE } from "@/lib/uuid";

// Class insights slice 2 (docs/class-insights-design.md): the stored class
// report for one (assessment, section filter).
//
//   GET  ?section=   the stored report, names swapped in at render, plus
//                    `stale` (the current evidence pack's hash differs) —
//                    404 `none` when nothing is stored. `view` level.
//   POST {section}   build the pack, one model call, fill + validate, store
//                    (a regenerate overwrites), return the rendered report.
//                    `edit` level; 409 `nothing_to_report` when no handed-in
//                    student has a final score.
//
// NOT gated on `allow_llm_authoring`: that flag governs AI AUTHORING of the
// assessment's items, and the results-side AI (essay scoring, rescore-ai)
// has never consulted it. This report is results-side.

type Db = ReturnType<typeof getDb>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PostBody = z.object({ section: z.string().max(200).nullable().optional() });

/** Results with in-progress rows too, so a passed-back student keeps a name. */
function loadResults(id: string): Promise<AssessmentResults> {
  return buildResults(id, { include_in_progress: true });
}

async function renderPayload(
  db: Db,
  assessmentId: string,
  row: ClassInsightReportRow,
  results: AssessmentResults,
  current: { hash: string; note: string | null },
) {
  const itemRows = await db
    .select({ id: items.id, position: items.position })
    .from(items)
    .where(eq(items.assessment_id, assessmentId));
  const report = row.report as unknown as ClassInsightsReport;
  const tags = [
    ...new Set(REPORT_SECTIONS.flatMap((s) => (report[s] ?? []).flatMap((c) => c.citations.tags))),
  ];
  return {
    ok: true as const,
    section_key: row.section_key,
    sections: renderReport(report, {
      pseudonyms: row.pseudonyms,
      itemIds: row.item_ids,
      nameByAttempt: new Map(results.rows.map((r) => [r.attempt_id, r.student.name])),
      positionByItem: new Map(itemRows.map((i) => [i.id, i.position])),
      tagLookup: lookupTags(tags),
    }),
    stale: current.hash !== row.pack_hash,
    note: current.note,
    dropped_claims: row.dropped_claims,
    model_id: row.model_id,
    prompt_version: row.prompt_version,
    created_at: row.created_at,
  };
}

export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "view");
  if (!access.ok) return access.response;

  const section = normalizeSection(new URL(req.url).searchParams.get("section"));
  const [row] = await db
    .select()
    .from(class_insight_reports)
    .where(
      and(
        eq(class_insight_reports.assessment_id, id),
        eq(class_insight_reports.section_key, sectionKey(section)),
      ),
    )
    .limit(1);
  if (!row) return NextResponse.json({ ok: false, error: "none" }, { status: 404 });

  const results = await loadResults(id);
  const { pack } = await buildEvidencePack(db, { assessmentId: id, section, results });
  return NextResponse.json(
    await renderPayload(db, id, row, results, { hash: pack.hash, note: pack.scope.note }),
  );
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: "body is not JSON" },
      { status: 400 },
    );
  }
  const parsed = PostBody.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail: "section must be a string or null" },
      { status: 400 },
    );
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return access.response;

  const section = normalizeSection(parsed.data.section);
  const results = await loadResults(id);
  const { pack, names, items: itemIds } = await buildEvidencePack(db, {
    assessmentId: id,
    section,
    results,
  });
  if (pack.students.length === 0) {
    return NextResponse.json({ ok: false, error: "nothing_to_report" }, { status: 409 });
  }

  // The model sees the pack WITHOUT its hash; `names` and `itemIds` never
  // leave the server.
  const { hash, ...packForModel } = pack;
  const provider = getProvider();

  // Guardrail (surface "class-insights", migration 0052): OUTPUT only. The
  // input is the server-built pack — scores, analytics, the scorer's
  // rationale and anonymous short-answer clusters (alert-flagged answers
  // already out) — with no teacher or student free text typed for this call,
  // so there is nothing for an input check to screen that the essay scorer's
  // own checks have not. The output check reads the filled claims.
  let outcome;
  try {
    outcome = await runGuarded({
      surface: "class-insights",
      ownerSub: auth.session.sub,
      run: async () => {
        const raw = await provider.generateClassInsights(packForModel, auth.session.sub);
        const filled = fillReport(raw, packForModel);
        const kept = REPORT_SECTIONS.reduce((n, s) => n + filled.report[s].length, 0);
        if (kept === 0) throw new Error("report_invalid: no claim survived validation");
        return filled;
      },
      outputText: (r) => reportText(r.report),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "provider_failed";
    return NextResponse.json({ ok: false, error: "provider_failed", detail: message }, { status: 502 });
  }
  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "guardrail_blocked",
        stage: outcome.stage,
        findings: outcome.findings,
        note: "The AI's report was withheld by content safeguards. Try again.",
      },
      { status: 422 },
    );
  }

  const pseudonyms = Object.fromEntries(
    Object.entries(names).map(([pseudonym, n]) => [pseudonym, n.attempt_id]),
  );
  const values = {
    report: outcome.result.report as unknown as Record<string, unknown>,
    pseudonyms,
    item_ids: itemIds,
    pack_hash: hash,
    model_id: provider.id,
    prompt_version: CLASS_INSIGHTS_PROMPT_VERSION,
    dropped_claims: outcome.result.dropped,
    created_by_sub: auth.session.sub,
  };
  const [row] = await db
    .insert(class_insight_reports)
    .values({ assessment_id: id, section_key: sectionKey(section), ...values })
    .onConflictDoUpdate({
      target: [class_insight_reports.assessment_id, class_insight_reports.section_key],
      set: { ...values, created_at: sql`now()` },
    })
    .returning();

  return NextResponse.json(
    await renderPayload(db, id, row!, results, { hash, note: pack.scope.note }),
  );
}
