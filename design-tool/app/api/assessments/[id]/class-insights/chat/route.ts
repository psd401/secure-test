import { NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  class_insight_reports,
  class_insight_threads,
  class_insight_turns,
  items,
  responses,
  safeguarding_alerts,
  type ClassInsightThreadRow,
  type ClassInsightTurnRow,
} from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { getProvider } from "@/lib/ai/provider";
import { isUniqueViolation } from "@/lib/db/isUniqueViolation";
import {
  HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  MAX_REPLY_CHARS,
  MAX_THREAD_TURNS,
  buildPseudonymizer,
  extendPseudonyms,
  mentionedQuestions,
  mentionedStudents,
  plainLabels,
  pseudonymizeMessage,
  pullableQuestions,
  relabelPack,
  reportForChat,
  selectAnswers,
  type AnswerCandidate,
  type ClassInsightsChatInput,
} from "@/lib/insights/chat";
import { CLASS_INSIGHTS_CHAT_PROMPT_VERSION } from "@/lib/insights/chatPrompt";
import { buildEvidencePack } from "@/lib/insights/evidencePack";
import { fillSingleClaim, type ClassInsightsReport, type FilledClaim } from "@/lib/insights/report";
import { normalizeSection, renderClaim, sectionKey } from "@/lib/insights/reportView";
import { runGuarded } from "@/lib/safeguarding/guard";
import { buildResults, type AssessmentResults } from "@/lib/scoring/results";
import { lookupTags } from "@/lib/standards/search";
import { UUID_RE } from "@/lib/uuid";

// Class insights slice 4 (docs/class-insights-design.md, D-4 / D-5 / D-6):
// the teacher's own conversation about one (assessment, section filter).
//
//   GET    ?section=           the caller's thread, names swapped in at
//                              render, each turn marked `stale_turn` when it
//                              was answered from an older evidence pack; an
//                              empty thread when none exists.
//   POST   {section, message}  one model call; on success the teacher turn
//                              (pseudonymized) and the reply are stored in
//                              one transaction and returned rendered. A
//                              refused, failed or blocked reply stores
//                              NOTHING, so a retry starts clean.
//   DELETE ?section=           deletes the caller's thread.
//
// All three at `edit` (like generating the report); one thread per teacher
// (D-5), so a co-teacher at `edit` has their own. Names never reach the model
// or a stored row (D-1): the message is pseudonymized before anything else.

type Db = ReturnType<typeof getDb>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PostBody = z.object({
  section: z.string().max(200).nullable().optional(),
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

function loadResults(id: string): Promise<AssessmentResults> {
  return buildResults(id, { include_in_progress: true });
}

async function gate(ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return {
      ok: false as const,
      response: NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 }),
    };
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit");
  if (!access.ok) return { ok: false as const, response: access.response };
  return { ok: true as const, db, id, sub: auth.session.sub };
}

async function loadThread(db: Db, assessmentId: string, ownerSub: string, key: string) {
  const [thread] = await db
    .select()
    .from(class_insight_threads)
    .where(
      and(
        eq(class_insight_threads.assessment_id, assessmentId),
        eq(class_insight_threads.owner_sub, ownerSub),
        eq(class_insight_threads.section_key, key),
      ),
    )
    .limit(1);
  if (!thread) return { thread: null, turns: [] as ClassInsightTurnRow[] };
  const turns = await db
    .select()
    .from(class_insight_turns)
    .where(eq(class_insight_turns.thread_id, thread.id))
    .orderBy(asc(class_insight_turns.position));
  return { thread, turns };
}

async function renderTurns(
  db: Db,
  assessmentId: string,
  thread: Pick<ClassInsightThreadRow, "pseudonyms" | "item_ids">,
  turns: ClassInsightTurnRow[],
  results: AssessmentResults,
  currentHash: string,
) {
  const itemRows = await db
    .select({ id: items.id, position: items.position })
    .from(items)
    .where(eq(items.assessment_id, assessmentId));
  const tags = [...new Set(turns.flatMap((t) => t.citations.tags))];
  const ctx = {
    pseudonyms: thread.pseudonyms,
    itemIds: thread.item_ids,
    nameByAttempt: new Map(results.rows.map((r) => [r.attempt_id, r.student.name])),
    positionByItem: new Map(itemRows.map((i) => [i.id, i.position])),
    tagLookup: lookupTags(tags),
  };
  return turns.map((t) => ({
    position: t.position,
    role: t.role as "teacher" | "assistant",
    ...renderClaim({ text: t.text, citations: t.citations, figures: t.figures }, ctx),
    stale_turn: t.pack_hash !== currentHash,
    created_at: t.created_at,
  }));
}

/**
 * D-6: the handed-in answers to the pullable questions the message names, of
 * the students it names (all pack students when it names none), each with
 * whether an OPEN safeguarding alert sits on it. Pack students only: an
 * attempt with no final score anywhere has no pseudonym to attribute to.
 */
async function loadAnswerCandidates(
  db: Db,
  {
    questions,
    itemIds,
    students,
    pseudonyms,
  }: {
    questions: string[];
    itemIds: Record<string, string>;
    students: string[];
    pseudonyms: Record<string, string>;
  },
): Promise<AnswerCandidate[]> {
  const labelByItem = new Map(questions.map((q) => [itemIds[q]!, q]));
  const labelByAttempt = new Map(students.map((s) => [pseudonyms[s]!, s]));
  if (labelByItem.size === 0 || labelByAttempt.size === 0) return [];
  const rows = await db
    .select({
      response_id: responses.id,
      attempt_id: responses.attempt_id,
      item_id: responses.item_id,
      response: responses.response,
    })
    .from(responses)
    .where(
      and(
        inArray(responses.item_id, [...labelByItem.keys()]),
        inArray(responses.attempt_id, [...labelByAttempt.keys()]),
      ),
    );
  if (rows.length === 0) return [];
  const alerts = await db
    .selectDistinct({ response_id: safeguarding_alerts.response_id })
    .from(safeguarding_alerts)
    .where(
      and(
        inArray(
          safeguarding_alerts.response_id,
          rows.map((r) => r.response_id),
        ),
        isNull(safeguarding_alerts.acknowledged_at),
      ),
    );
  const open = new Set(alerts.map((a) => a.response_id));
  return rows.map((r) => {
    const body = r.response as unknown as { text?: unknown } | null;
    return {
      response_id: r.response_id,
      question: labelByItem.get(r.item_id)!,
      student: labelByAttempt.get(r.attempt_id)!,
      text: typeof body?.text === "string" ? body.text : "",
      open_alert: open.has(r.response_id),
    };
  });
}

export async function GET(req: Request, ctx: RouteContext) {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { db, id, sub } = g;
  const section = normalizeSection(new URL(req.url).searchParams.get("section"));
  const key = sectionKey(section);
  const { thread, turns } = await loadThread(db, id, sub, key);
  if (!thread) {
    return NextResponse.json({
      ok: true,
      section_key: key,
      turns: [],
      turns_left: MAX_THREAD_TURNS,
      max_turns: MAX_THREAD_TURNS,
    });
  }
  const results = await loadResults(id);
  const { pack } = await buildEvidencePack(db, { assessmentId: id, section, results });
  return NextResponse.json({
    ok: true,
    section_key: key,
    turns: await renderTurns(db, id, thread, turns, results, pack.hash),
    turns_left: Math.max(0, MAX_THREAD_TURNS - turns.length),
    max_turns: MAX_THREAD_TURNS,
  });
}

export async function POST(req: Request, ctx: RouteContext) {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { db, id, sub } = g;

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
      {
        ok: false,
        error: "invalid_body",
        detail: `message must be 1–${MAX_MESSAGE_CHARS} characters; section a string or null`,
      },
      { status: 400 },
    );
  }
  const section = normalizeSection(parsed.data.section);
  const key = sectionKey(section);

  const { thread, turns } = await loadThread(db, id, sub, key);
  if (turns.length + 2 > MAX_THREAD_TURNS) {
    return NextResponse.json(
      { ok: false, error: "thread_full", note: "Start a new conversation." },
      { status: 409 },
    );
  }

  const results = await loadResults(id);
  const { pack, names, items: itemIds } = await buildEvidencePack(db, {
    assessmentId: id,
    section,
    results,
  });
  if (pack.students.length === 0) {
    return NextResponse.json({ ok: false, error: "nothing_to_report" }, { status: 409 });
  }

  // Thread numbering first: everything below speaks it.
  const { hash, ...packAsBuilt } = pack;
  const ext = extendPseudonyms(thread?.pseudonyms ?? {}, names);
  const packForModel = relabelPack(packAsBuilt, ext.packToThread);
  const pseudonymizer = buildPseudonymizer(ext.namesByThread);

  // D-1: names out of the message before anything else reads it.
  const message = pseudonymizeMessage(parsed.data.message, pseudonymizer);

  // D-6: the answer pull — deterministic, only on a named essay / short-text
  // question, narrowed to the students the message names.
  const questions = pullableQuestions(mentionedQuestions(message.plain, packForModel), packForModel);
  let answers: ClassInsightsChatInput["answers"] = [];
  if (questions.length > 0) {
    const named = mentionedStudents(message.plain, packForModel);
    const students = named.length > 0 ? named : packForModel.students.map((s) => s.id);
    answers = selectAnswers(
      await loadAnswerCandidates(db, {
        questions,
        itemIds,
        students,
        pseudonyms: ext.pseudonyms,
      }),
      pseudonymizer,
    );
  }

  const [reportRow] = await db
    .select()
    .from(class_insight_reports)
    .where(
      and(eq(class_insight_reports.assessment_id, id), eq(class_insight_reports.section_key, key)),
    )
    .limit(1);
  const report = reportRow
    ? reportForChat(
        {
          report: reportRow.report as unknown as ClassInsightsReport,
          pseudonyms: reportRow.pseudonyms,
          item_ids: reportRow.item_ids,
        },
        ext.pseudonyms,
        itemIds,
        reportRow.pack_hash !== hash,
      )
    : null;

  const input: ClassInsightsChatInput = {
    pack: packForModel,
    report,
    history: turns.slice(-HISTORY_TURNS).map((t) => ({
      role: t.role as "teacher" | "assistant",
      text: plainLabels(t.text),
    })),
    answers,
    message: message.plain,
  };

  const provider = getProvider();
  // Guardrail (surface "class-insights"): the INPUT check reads the teacher's
  // pseudonymized message and enforces. The pulled answers are NOT screened —
  // student writing about literature trips the content filters (the essay
  // scorer's record mode exists for that) and runGuarded takes one input
  // text; the output check on the filled reply still blocks.
  let outcome;
  try {
    outcome = await runGuarded({
      surface: "class-insights",
      ownerSub: sub,
      inputText: message.plain,
      run: async (): Promise<FilledClaim> => {
        const raw = await provider.classInsightsChat(input, sub);
        const filled = fillSingleClaim(raw, packForModel, { maxText: MAX_REPLY_CHARS });
        if (!filled) throw new Error("chat_reply_invalid: the reply failed validation");
        return filled;
      },
      outputText: (r) => plainLabels(r.text),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "provider_failed";
    return NextResponse.json({ ok: false, error: "provider_failed", detail }, { status: 502 });
  }
  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "guardrail_blocked",
        stage: outcome.stage,
        findings: outcome.findings,
        note:
          outcome.stage === "input"
            ? "Your message was stopped by content safeguards. Try rewording it."
            : "The AI's reply was withheld by content safeguards. Try again.",
      },
      { status: 422 },
    );
  }
  const reply = outcome.result;

  let threadRow: ClassInsightThreadRow;
  let stored: ClassInsightTurnRow[];
  try {
    [threadRow, stored] = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(class_insight_threads)
        .values({
          assessment_id: id,
          owner_sub: sub,
          section_key: key,
          pseudonyms: ext.pseudonyms,
          item_ids: itemIds,
        })
        .onConflictDoUpdate({
          target: [
            class_insight_threads.assessment_id,
            class_insight_threads.owner_sub,
            class_insight_threads.section_key,
          ],
          set: { pseudonyms: ext.pseudonyms, item_ids: itemIds, updated_at: sql`now()` },
        })
        .returning();
      const rows = await tx
        .insert(class_insight_turns)
        .values([
          {
            thread_id: t!.id,
            position: turns.length,
            role: "teacher",
            text: message.stored,
            citations: { items: [], tags: [], students: [] },
            figures: [],
            pack_hash: hash,
          },
          {
            thread_id: t!.id,
            position: turns.length + 1,
            role: "assistant",
            text: reply.text,
            citations: reply.citations,
            figures: reply.figures,
            read_response_ids: answers.map((a) => a.response_id),
            pack_hash: hash,
            model_id: provider.id,
            prompt_version: CLASS_INSIGHTS_CHAT_PROMPT_VERSION,
          },
        ])
        .returning();
      return [t!, rows] as const;
    });
  } catch (err) {
    // Another message landed on this thread first (same position).
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { ok: false, error: "conflict", note: "Another message was answered first. Reload." },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({
    ok: true,
    section_key: key,
    turns: await renderTurns(
      db,
      id,
      threadRow,
      [...stored].sort((a, b) => a.position - b.position),
      results,
      hash,
    ),
    turns_left: Math.max(0, MAX_THREAD_TURNS - turns.length - 2),
    max_turns: MAX_THREAD_TURNS,
  });
}

export async function DELETE(req: Request, ctx: RouteContext) {
  const g = await gate(ctx);
  if (!g.ok) return g.response;
  const { db, id, sub } = g;
  const key = sectionKey(normalizeSection(new URL(req.url).searchParams.get("section")));
  const deleted = await db
    .delete(class_insight_threads)
    .where(
      and(
        eq(class_insight_threads.assessment_id, id),
        eq(class_insight_threads.owner_sub, sub),
        eq(class_insight_threads.section_key, key),
      ),
    )
    .returning({ id: class_insight_threads.id });
  return NextResponse.json({ ok: true, deleted: deleted.length > 0 });
}
