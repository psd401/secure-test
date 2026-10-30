// FR R-3 (docs/feedback-release-design.md): one content model for what a
// student is sent — the Google Doc (lib/googleDocs/content.ts renders it to
// HTML) and, slice 4, the student-work packet (renders it to JSX) — so the two
// cannot drift and every combination of boxes is tested without Drive or a
// browser.
//
// Pure: the ticked boxes, each question's score rows, rubric and teacher
// comment, and the overall comment in — labelled blocks out. Nothing here
// reads the database or renders anything. Type-agnostic: rows and a rubric
// in, so short answers (slice 5) need no change here.

import type { Rubric } from "@secure-test/schema";
import { overallRationale, rubricScoreRows } from "@/lib/reporting/rubricScoreView";
import { selectPacketScores, type PacketScoreRow } from "@/lib/reporting/workPacket";

/** D-2 / R-2: the boxes this model reads; each output adds its own (prompt, answer…). */
export interface FeedbackContents {
  teacher_score: boolean;
  ai_score: boolean;
  teacher_feedback: boolean;
  ai_feedback: boolean;
  rubric_table: boolean;
}

export type ScoreMethod = "human" | "ai" | "auto";

/** FR D-1 / D-13: every score says whose it is; an answer key's is plain "Score". */
export function scoreLabel(method: ScoreMethod): string {
  if (method === "ai") return "AI score";
  if (method === "human") return "Teacher score";
  return "Score";
}

export interface FeedbackQuestionInput<T extends PacketScoreRow = PacketScoreRow> {
  /** The item's rubric (or the row's snapshot); null for a question without one. */
  rubric: Rubric | null;
  /** Every non-research row for the response; research and superseded rows are ignored here too. */
  scores: T[];
  /** The teacher's own comment (response_feedback, R-1), or null. */
  teacher_feedback: string | null;
  /**
   * When the student last changed this answer (`responses.updated_at`, which
   * moves only on a student edit); null when there is no answer. An AI row
   * older than this is about an earlier answer — a pass-back leaves proposals
   * in place — so its comments are not D-10's AI feedback.
   */
  answer_updated_at: Date | null;
  /**
   * Leave the AI's comments out for this question (PR #157 review): an AI
   * short answer's level descriptors are seeded from its correct answer, so
   * on a wrong answer the AI's rationale can name the expected answer — a
   * key leak while a makeup sitting is open. Callers set it for `short_text`
   * on anything a student receives; the AI score and its level label still
   * print under their own boxes. Absent = false.
   */
  withhold_ai_feedback?: boolean;
}

export interface FeedbackReleaseInput<T extends PacketScoreRow = PacketScoreRow> {
  questions: Array<FeedbackQuestionInput<T>>;
  /** The per-student overall comment (attempt_feedback, D-4), or null. */
  overall_teacher_feedback: string | null;
}

export interface RubricTableRow {
  criterion: string;
  /** The standing score's level; null when it chose none for this criterion. */
  level: string | null;
  points: number | null;
  /** The AI's comment on this criterion (D-10); null when it wrote none. */
  ai_feedback: string | null;
}

export type FeedbackBlock =
  | { kind: "score"; label: string; points: number; max_points: number }
  | {
      kind: "rubric_table";
      columns: { level: boolean; points: boolean; ai_feedback: boolean };
      rows: RubricTableRow[];
    }
  | {
      kind: "feedback";
      source: "teacher" | "ai";
      label: "Teacher feedback" | "AI feedback";
      /** The overall text; null when there are only per-criterion comments. */
      text: string | null;
      /** R-2 off: the AI's per-criterion comments as a labelled list. */
      criteria: Array<{ criterion: string; text: string }>;
    };

export interface FeedbackRelease {
  /** D-4: printed once, at the top. */
  overall: FeedbackBlock | null;
  /** One block list per input question, in input order. */
  questions: FeedbackBlock[][];
}

/**
 * The rubric a question's criteria resolve through: the item's own, else the
 * final row's snapshot, else any row's. One rule for the Doc and the packet
 * (R-3), so a criterion reads the same name in both.
 */
export function questionRubric(
  itemRubric: Rubric | null | undefined,
  rows: Array<{ status: string; rubric_snapshot?: Rubric | null }>,
): Rubric | null {
  return (
    itemRubric ??
    rows.find((r) => r.status === "final")?.rubric_snapshot ??
    rows.find((r) => r.rubric_snapshot)?.rubric_snapshot ??
    null
  );
}

function teacherBlock(text: string | null): FeedbackBlock | null {
  const t = text?.trim() ?? "";
  return t ? { kind: "feedback", source: "teacher", label: "Teacher feedback", text: t, criteria: [] } : null;
}

function asMethod(method: string): ScoreMethod {
  return method === "ai" ? "ai" : method === "auto" ? "auto" : "human";
}

/** The response's standing score: its `final` row (one per response), never a research one. */
function finalRow<T extends PacketScoreRow>(rows: T[]): T | null {
  let found: T | null = null;
  for (const row of rows) {
    if (row.status !== "final") continue;
    if (!found || row.created_at >= found.created_at) found = row;
  }
  return found;
}

/**
 * Whether this question's score prints, and under which label.
 * - D-3 / D-17: "AI score" only when the final row is the AI's — approved or
 *   a Hybrid final no teacher reviewed. An overridden or changed AI score is
 *   superseded or still `proposed`, so it is never the final and never prints.
 * - D-13: an answer key's score prints once, as "Score", with either box.
 */
function shownScore<T extends PacketScoreRow>(contents: FeedbackContents, final: T | null): T | null {
  if (!final) return null;
  const method = asMethod(final.method);
  if (method === "human") return contents.teacher_score ? final : null;
  if (method === "ai") return contents.ai_score ? final : null;
  return contents.teacher_score || contents.ai_score ? final : null;
}

function questionBlocks<T extends PacketScoreRow>(
  contents: FeedbackContents,
  q: FeedbackQuestionInput<T>,
): FeedbackBlock[] {
  const out: FeedbackBlock[] = [];
  const final = finalRow(q.scores);
  const shown = shownScore(contents, final);
  if (shown) {
    out.push({
      kind: "score",
      label: scoreLabel(asMethod(shown.method)),
      points: shown.points,
      max_points: shown.max_points,
    });
  }

  // D-10: the AI's comments come from the AI's own row — the latest
  // non-research, non-superseded `ai` row (the packet's own pick) — so they
  // survive an override; D-3 still hides that row's score and levels. An AI
  // row written before the answer last changed is about the old answer (a
  // pass-back leaves proposals alone), so it is dropped first.
  const answeredAt = q.answer_updated_at;
  const aiRow = contents.ai_feedback && !q.withhold_ai_feedback
    ? selectPacketScores(
        "ai",
        answeredAt ? q.scores.filter((r) => r.method !== "ai" || r.created_at >= answeredAt) : q.scores,
      ).ai
    : null;
  const aiCriteria = aiRow
    ? rubricScoreRows(q.rubric, aiRow.rationale).filter((c) => c.rationale !== null)
    : [];
  const aiOverall = aiRow ? overallRationale(aiRow.rationale) : null;

  if (contents.rubric_table) {
    // R-2: criterion and level, points only beside a printed score, the AI's
    // comments only with AI feedback. Levels and points come from the FINAL
    // row alone (D-3): never from an AI row a teacher overrode.
    const levels = final ? rubricScoreRows(q.rubric, final.rationale) : [];
    const byId = new Map<string, RubricTableRow>();
    const order: string[] = (q.rubric?.criteria ?? []).map((c) => c.id);
    const names = new Map((q.rubric?.criteria ?? []).map((c) => [c.id, c.name] as const));
    const row = (id: string, fallbackName: string): RubricTableRow => {
      let r = byId.get(id);
      if (!r) {
        r = { criterion: names.get(id) ?? fallbackName, level: null, points: null, ai_feedback: null };
        byId.set(id, r);
        if (!order.includes(id)) order.push(id);
      }
      return r;
    };
    for (const l of levels) {
      const r = row(l.criterion_id, l.criterion_name);
      r.level = l.level_label;
      r.points = shown ? l.points : null;
    }
    for (const c of aiCriteria) row(c.criterion_id, c.criterion_name).ai_feedback = c.rationale;
    const columns = {
      level: levels.length > 0,
      points: levels.length > 0 && shown !== null,
      ai_feedback: aiCriteria.length > 0,
    };
    // A table of bare criterion names says nothing: none at all instead.
    if (columns.level || columns.ai_feedback) {
      out.push({
        kind: "rubric_table",
        columns,
        rows: order.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
      });
    }
  }

  if (aiRow) {
    // R-2 off: the per-criterion comments print as a list under the label;
    // on, they are in the table's "AI feedback" column instead.
    const criteria = contents.rubric_table
      ? []
      : aiCriteria.map((c) => ({ criterion: c.criterion_name, text: c.rationale! }));
    if (aiOverall || criteria.length > 0) {
      out.push({
        kind: "feedback",
        source: "ai",
        label: "AI feedback",
        text: aiOverall ? aiOverall.trim() : null,
        criteria,
      });
    }
  }

  if (contents.teacher_feedback) {
    const t = teacherBlock(q.teacher_feedback);
    if (t) out.push(t);
  }
  return out;
}

/**
 * R-3: what each question, and the student overall, carries for the boxes
 * ticked. A `rationale.note` (a score-change reason) is never read: teacher
 * feedback comes only from its own tables (R-1, FR slice 1).
 */
export function buildFeedbackRelease<T extends PacketScoreRow>(
  contents: FeedbackContents,
  data: FeedbackReleaseInput<T>,
): FeedbackRelease {
  return {
    overall: contents.teacher_feedback ? teacherBlock(data.overall_teacher_feedback) : null,
    questions: data.questions.map((q) => questionBlocks(contents, q)),
  };
}
