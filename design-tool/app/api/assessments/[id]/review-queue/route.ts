import { NextResponse } from "next/server";
import { isAiUnreviewed } from "@/lib/scoring/methodLabel";
import { buildResults, matchesSectionFilter, sectionFilterOptions } from "@/lib/scoring/results";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  attempts,
  items,
  responses,
  scores,
  students,
  type ItemType,
  type ScoreRow, item_sets } from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";
import { resolveAssessmentAssets } from "@/lib/assets/assessmentAssets";
import { renderItemContent } from "@/lib/items/renderItemContent";
import { requireStaff } from "@/lib/api/requireSession";
import { resolveSourceText } from "@/lib/api/setSources";
import { renderShortTextAnswer } from "@/lib/reporting/shortTextView";
import { essayRichHtml, renderEssayAnswerHtml } from "@/lib/richText/renderEssayAnswer";
import { renderFillBlankAnswerHtml } from "@/lib/reporting/fillBlankView";
import { rubricMaxPoints } from "@/lib/ai/essayScorer/scoreCore";
import { fillBlankMaxPoints, tableMaxPoints, fillBlankHandScored } from "@/lib/scoring/auto";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";
import { alertsForResponses } from "@/lib/safeguarding/alertQueries";
import { graphAnswerLines, graphMaxPoints, type GraphObject } from "@secure-test/graphing/server";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Slice 39: everything on this assessment that still needs a human —
// responses of submitted attempts whose item's effective method is NOT
// auto and that have no final score yet. Two client-side groups fall out
// of `proposed`: null = needs a manual score; non-null = an AI proposal
// awaiting approve/override. Auto items never appear (slice 37 finalizes
// them without review); neither do responses with a final — except, since
// Hybrid transparency slice 2, a final AI score no teacher reviewed, which is
// returned apart as `unreviewed`. `?section=` filters both lists.
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

  const attemptRows = await db
    .select()
    .from(attempts)
    // Practice (docs/practice-sitting-design.md, D-4): a staff member's own
    // practice hand-in never waits in the class's queue.
    .where(and(eq(attempts.assessment_id, id), eq(attempts.practice, false)))
    .orderBy(asc(attempts.started_at));
  const submitted = attemptRows.filter((a) => a.status === "submitted");
  if (submitted.length === 0) {
    return NextResponse.json({
      entries: [],
      unreviewed: [],
      sections: { labels: [], hasBlank: false },
    });
  }

  // Hybrid transparency slice 2, decision 5.4: the queue filters by section
  // the way the results matrix does, so "Review them" under one section lands
  // on that section's cards. The labels come from buildResults itself — the
  // matrix's own resolution — so the two pages can never disagree on who is
  // in which section.
  const sectionFilter = new URL(req.url).searchParams.get("section") ?? "";
  const results = await buildResults(id);
  const sectionByAttempt = new Map(
    results.rows.map((r) => [r.attempt_id, r.student.section]),
  );

  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));
  const itemsById = new Map(itemRows.map((i) => [i.id, i]));

  // Stems reach the queue rendered (math + image refs) so hand-scoring
  // reads a fraction, not KaTeX source. G-1: refs resolve under the
  // assessment's owner with the assessment-scoped URL, so a co-teacher scoring
  // sees the owner's pictures; refs to anyone else's assets render as the
  // inline-red placeholder.
  const stemRefs = extractAssetRefsFromMany(itemRows.map((i) => i.stem));
  const resolvedAssets = await resolveAssessmentAssets(db, access.assessment, stemRefs);
  const stemHtmlByItem = new Map(
    itemRows.map((i) => [i.id, renderItemContent(i.stem, resolvedAssets)]),
  );

  // Scope the roster lookup to the assessment's OWNER, not just to the
  // attempt's student_id — same reasoning as lib/scoring/results.ts. Access
  // to the ASSESSMENT says nothing about who owns the STUDENT an attempt
  // points at; `attempts.student_id` carries no tenant constraint. The owner's
  // overlay (not the caller's — a co-teacher or admin has none for these
  // students, 2026-09-21) is the one the ingest wrote against. A student that
  // fails the predicate is absent from the map and renders as "(unknown)".
  const studentRows = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.owner_sub, access.assessment.owner_sub),
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
            // The queue never offers a research row for review
            // (docs/scoring-corpus-design.md slice 1).
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              ne(scores.status, "research"),
            ),
          )
      : [];
  const finalByResponse = new Map(
    scoreRows.filter((s) => s.status === "final").map((s) => [s.response_id, s]),
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
  // Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): each
  // entry carries the alerts on its answer — the newest UNFORCED
  // prompt-injection alert (the one withholding the AI score, D-4, whether or
  // not it has been acknowledged) and every wellbeing alert.
  const alertsByResponse = await alertsForResponses(
    db,
    responseRows.map((r) => r.id),
  );
  const outlineCache = new Map<string, { origin: "source" | "inline" | "missing"; words: number }>();
  const entries = [];
  // Hybrid transparency slice 2 (D-3): the third list — responses whose FINAL
  // is an AI score no teacher reviewed (Hybrid settled it on its own). Listed
  // whatever the item's method is now; Approve marks it reviewed, Change
  // replaces it, and either takes it off the list.
  const unreviewed = [];
  for (const response of responseRows) {
    const item = itemsById.get(response.item_id);
    if (!item) continue;
    const method = effectiveScoringMethod(item.type as ItemType, item.config);
    const final = finalByResponse.get(response.id) ?? null;
    if (final ? !isAiUnreviewed(final) : method === "auto") continue;
    const attempt = attemptsById.get(response.attempt_id);
    if (!attempt) continue;
    const section = sectionByAttempt.get(attempt.id) ?? null;
    if (!matchesSectionFilter(section, sectionFilter)) continue;
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
    const responseAlerts = alertsByResponse.get(response.id) ?? [];
    const injection =
      responseAlerts.find((a) => a.kind === "prompt_injection" && a.ai_forced_at === null) ?? null;
    // SG-F1 (2026-09-25 local check): once the teacher chose Score with AI
    // anyway, the card still says why the answer was flagged, so whoever
    // approves the proposal later can tell.
    const forcedInjection = injection
      ? null
      : (responseAlerts.find((a) => a.kind === "prompt_injection" && a.ai_forced_at !== null) ??
        null);
    const card = {
      section,
      outline,
      safeguarding: {
        injection: injection
          ? {
              id: injection.id,
              category: injection.category,
              evidence: injection.evidence,
              created_at: injection.created_at,
              acknowledged_at: injection.acknowledged_at,
            }
          : null,
        injection_forced: forcedInjection
          ? { id: forcedInjection.id, ai_forced_at: forcedInjection.ai_forced_at }
          : null,
        wellbeing: responseAlerts
          .filter((a) => a.kind === "wellbeing")
          .map((a) => ({
            id: a.id,
            category: a.category,
            acknowledged_at: a.acknowledged_at,
          })),
      },
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
            : item.type === "fill_blank"
              ? fillBlankMaxPoints(item.config)
              : item.type === "graph" && item.config.graph_board && item.config.graph_key
                ? graphMaxPoints(item.config.graph_board, item.config.graph_key)
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
      // Roadmap 4b-f (2026-09-14, docs/math-entry-design.md): a short-text
      // answer is rendered math on the student's screen, so the queue shows
      // the same picture rather than the raw `4^2`. Rendered HERE for the same
      // reason stem_html is — the panel is a client component and KaTeX has no
      // business in its bundle. `response` still carries the raw text.
      answer_html:
        response.response.type === "short_text" &&
        typeof (response.response as { text?: unknown }).text === "string" &&
        (response.response as { text: string }).text !== ""
          ? renderShortTextAnswer((response.response as { text: string }).text)
          : null,
      // RT slice 2 (docs/rich-text-essay-design.md): a FORMATTED essay as
      // html, through the one sanitising renderer (the stored html is cleaned
      // again here). Null for a plain essay — the card shows `response.text`
      // as before — and for every other type. `response` still carries `text`
      // and the stored `html`, but the card never renders the raw field.
      essay_html:
        response.response.type === "essay" && essayRichHtml(response.response) !== null
          ? renderEssayAnswerHtml(response.response)
          : null,
      // FB slice 3 (docs/fill-in-blank-design.md): a fill-in-the-blank answer
      // as the sentence — the student's answers in place, ✓ / ✗ and the
      // expected answer on each keyed blank, "no key" on an unkeyed one, and
      // the n-of-m line. Rendered here for stem_html's reason (KaTeX stays
      // out of the client bundle); renderFillBlankAnswerHtml escapes the
      // answers and sends stem text through renderItemContent. Teacher-only
      // surface — keys are fine here, as the table's are.
      fill_blank_html:
        item.type === "fill_blank"
          ? renderFillBlankAnswerHtml(
              item.stem,
              item.config.blanks,
              response.response as unknown as Record<string, unknown>,
              resolvedAssets,
              { showKey: true, summary: true, handScored: fillBlankHandScored(item.config) },
            )
          : null,
      // Graphing calculator D-9: a graph answer in words, one line per
      // object ("y = 2x + 1"), marked against the key when there is one —
      // teacher-only, like the table's keys. Null for every other type.
      graph_lines:
        item.type === "graph" && item.config.graph_board
          ? graphAnswerLines(
              item.config.graph_board,
              item.config.graph_key ?? null,
              ((response.response as { objects?: GraphObject[] }).objects ?? []) as GraphObject[],
            )
          : null,
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
    };
    if (final) {
      unreviewed.push({
        ...card,
        final: {
          score_id: final.id,
          points: final.points,
          max_points: final.max_points,
          rationale: final.rationale,
          scorer: final.scorer,
          created_at: final.created_at,
        },
      });
    } else {
      entries.push(card);
    }
  }
  // Stable order: item position, then attempt start (review fix 2026-08-14:
  // this previously tiebroke on attempt UUID despite the comment), then
  // attempt id as the final stable tiebreak.
  const attemptStart = new Map(
    submitted.map((a) => [a.id, a.started_at?.getTime() ?? 0]),
  );
  const byQuestionThenStart = (
    a: { item: { position: number }; attempt_id: string },
    b: { item: { position: number }; attempt_id: string },
  ) =>
    a.item.position - b.item.position ||
    (attemptStart.get(a.attempt_id) ?? 0) - (attemptStart.get(b.attempt_id) ?? 0) ||
    a.attempt_id.localeCompare(b.attempt_id);
  entries.sort(byQuestionThenStart);
  unreviewed.sort(byQuestionThenStart);

  return NextResponse.json({
    entries,
    unreviewed,
    sections: sectionFilterOptions(results),
  });
}
