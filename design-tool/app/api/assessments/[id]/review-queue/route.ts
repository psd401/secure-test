import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  assessments,
  assets,
  attempts,
  items,
  responses,
  scores,
  students,
  type ItemType,
  type ScoreRow, item_sets } from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";
import {
  renderItemContent,
  type ResolvedAsset,
} from "@/lib/items/renderItemContent";
import { requireStaff } from "@/lib/api/requireSession";
import { resolveSourceText } from "@/lib/api/setSources";
import { rubricMaxPoints } from "@/lib/ai/essayScorer/scoreCore";
import { tableMaxPoints } from "@/lib/scoring/auto";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Slice 39: everything on this assessment that still needs a human —
// responses of submitted attempts whose item's effective method is NOT
// auto and that have no final score yet. Two client-side groups fall out
// of `proposed`: null = needs a manual score; non-null = an AI proposal
// awaiting approve/override. Auto items never appear (slice 37 finalizes
// them without review); neither do responses with a final.
export async function GET(_req: Request, ctx: RouteContext) {
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

  const attemptRows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.assessment_id, id))
    .orderBy(asc(attempts.started_at));
  const submitted = attemptRows.filter((a) => a.status === "submitted");
  if (submitted.length === 0) {
    return NextResponse.json({ entries: [] });
  }

  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));
  const itemsById = new Map(itemRows.map((i) => [i.id, i]));

  // Stems reach the queue rendered (math + image refs) so hand-scoring
  // reads a fraction, not KaTeX source. Same owner-scoped asset resolution
  // as the editor's renderContent action: refs to other users' assets fall
  // out of the lookup and render as the inline-red placeholder.
  const stemRefs = extractAssetRefsFromMany(itemRows.map((i) => i.stem));
  const resolvedAssets = new Map<string, ResolvedAsset>();
  if (stemRefs.length > 0) {
    const assetRows = await db
      .select({ id: assets.id, content_type: assets.content_type })
      .from(assets)
      .where(
        and(eq(assets.owner_sub, auth.session.sub), inArray(assets.id, stemRefs)),
      );
    for (const r of assetRows) {
      resolvedAssets.set(r.id.toLowerCase(), {
        id: r.id,
        content_type: r.content_type,
      });
    }
  }
  const stemHtmlByItem = new Map(
    itemRows.map((i) => [i.id, renderItemContent(i.stem, resolvedAssets)]),
  );

  // Scope the roster lookup to the caller, not just to the attempt's
  // student_id — same reasoning as lib/scoring/results.ts. Owning the
  // ASSESSMENT says nothing about who owns the STUDENT an attempt points at;
  // `attempts.student_id` carries no tenant constraint. A student that fails
  // the predicate is absent from the map and renders as "(unknown)" below.
  const studentRows = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.owner_sub, auth.session.sub),
        inArray(
          students.id,
          submitted.map((a) => a.student_id),
        ),
      ),
    );
  const studentsById = new Map(studentRows.map((s) => [s.id, s]));
  const attemptsById = new Map(submitted.map((a) => [a.id, a]));

  const responseRows = await db
    .select()
    .from(responses)
    .where(
      inArray(
        responses.attempt_id,
        submitted.map((a) => a.id),
      ),
    );

  const scoreRows: ScoreRow[] =
    responseRows.length > 0
      ? await db
          .select()
          .from(scores)
          .where(
            inArray(
              scores.response_id,
              responseRows.map((r) => r.id),
            ),
          )
      : [];
  const finals = new Set(
    scoreRows.filter((s) => s.status === "final").map((s) => s.response_id),
  );
  // Latest proposed per response (created_at, then insertion order).
  const proposedByResponse = new Map<string, ScoreRow>();
  for (const s of scoreRows) {
    if (s.status !== "proposed") continue;
    const prev = proposedByResponse.get(s.response_id);
    if (!prev || s.created_at >= prev.created_at) {
      proposedByResponse.set(s.response_id, s);
    }
  }

  // E12 slice 4: for a question under a source-backed stimulus, say what
  // that student actually saw — their saved outline, one written in place,
  // or nothing — so the reader of the essay knows (decision D-6).
  const setSourceRows = await db
    .select({ id: item_sets.id, source_item_id: item_sets.source_item_id })
    .from(item_sets)
    .where(eq(item_sets.assessment_id, id));
  const sourceOfSet = new Map(setSourceRows.map((s) => [s.id, s.source_item_id]));
  const outlineCache = new Map<string, { origin: "source" | "inline" | "missing"; words: number }>();
  const entries = [];
  for (const response of responseRows) {
    const item = itemsById.get(response.item_id);
    if (!item) continue;
    const method = effectiveScoringMethod(item.type as ItemType, item.config);
    if (method === "auto") continue;
    if (finals.has(response.id)) continue;
    const attempt = attemptsById.get(response.attempt_id);
    if (!attempt) continue;
    const student = studentsById.get(attempt.student_id);
    const proposed = proposedByResponse.get(response.id) ?? null;
    const sourceItemId = item.item_set_id ? (sourceOfSet.get(item.item_set_id) ?? null) : null;
    let outline: { origin: "source" | "inline" | "missing"; words: number } | null = null;
    if (sourceItemId) {
      const key = `${attempt.id}:${sourceItemId}`;
      let cached = outlineCache.get(key);
      if (!cached) {
        const resolved = await resolveSourceText(db, sourceItemId, attempt.student_id, attempt.id);
        cached = { origin: resolved.origin, words: resolved.text ? resolved.text.trim().split(/\s+/).length : 0 };
        outlineCache.set(key, cached);
      }
      outline = cached;
    }
    entries.push({
      outline,
      response_id: response.id,
      attempt_id: response.attempt_id,
      student: student
        ? { name: student.name, ssid: student.ssid }
        : { name: "(unknown)", ssid: "" },
      item: {
        id: item.id,
        position: item.position,
        type: item.type,
        stem: item.stem,
        stem_html: stemHtmlByItem.get(item.id) ?? "",
        scoring_method: method,
        rubric: item.config.rubric ?? null,
        // E3 slice 2: what the manual score route will accept as max_points
        // — the rubric max, a table's cells, else 1 — so the queue's points
        // field asks for the right denominator.
        max_points: item.config.rubric
          ? rubricMaxPoints(item.config.rubric)
          : item.type === "table"
            ? tableMaxPoints(item.config)
            : 1,
        // E3 slice 2: the grid and its keys, so the hand-scorer sees the
        // student's cells laid out and the expected text beside each keyed
        // one. Teacher-only surface — keys are fine here.
        table:
          item.type === "table"
            ? {
                columns: item.config.columns ?? [],
                rows: item.config.rows ?? [],
                corner: item.config.corner ?? null,
                cell_keys: item.config.cell_keys ?? null,
              }
            : null,
      },
      response: response.response,
      proposed: proposed
        ? {
            score_id: proposed.id,
            points: proposed.points,
            max_points: proposed.max_points,
            rationale: proposed.rationale,
            scorer: proposed.scorer,
            created_at: proposed.created_at,
          }
        : null,
    });
  }
  // Stable order: item position, then attempt start (review fix 2026-08-14:
  // this previously tiebroke on attempt UUID despite the comment), then
  // attempt id as the final stable tiebreak.
  const attemptStart = new Map(
    submitted.map((a) => [a.id, a.started_at?.getTime() ?? 0]),
  );
  entries.sort(
    (a, b) =>
      a.item.position - b.item.position ||
      (attemptStart.get(a.attempt_id) ?? 0) - (attemptStart.get(b.attempt_id) ?? 0) ||
      a.attempt_id.localeCompare(b.attempt_id),
  );

  return NextResponse.json({ entries });
}
