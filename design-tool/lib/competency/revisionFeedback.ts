import { and, desc, eq } from "drizzle-orm";
import type { DeliveryBundle, Rubric } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { items, response_feedback, responses, scores, type AssessmentRow, type AttemptRow } from "@/db/schema";
import { deriveCompetencyResult } from "@/lib/scoring/competencyResult";

type Db = ReturnType<typeof getDb>;

type RevisionFeedback = NonNullable<DeliveryBundle["revision_feedback"]>;

const MAX_TEXT = 2000;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

interface CriterionPick {
  criterion_id: string;
  level_id?: string;
  points?: number;
  rationale?: string;
}

/**
 * The scorer's feedback for a passed-back Needs Revision (docs/competency-
 * assessment-design.md, D-16, slice 7 server half), keyed by the option's
 * final-response item: per rubric row the criterion name, the level label
 * and the scorer's rationale, plus the response's written feedback as the
 * note.
 *
 * Read from the newest SUPERSEDED score on that response — pass back keeps
 * the old final as superseded (docs/pass-back-design.md) — and only while
 * no current final exists: once the revision is rescored, the panel has
 * nothing left to say. A superseded Pass or No Score sends nothing (a Pass
 * needs no revision; No Score carries no rubric rows). Null whenever there
 * is nothing to send, so the caller adds no field.
 */
export async function loadRevisionFeedback(
  db: Db,
  assessment: Pick<AssessmentRow, "id" | "assigned_scope" | "competency_pass_min_points">,
  attempt: Pick<AttemptRow, "id" | "pass_back_count">,
  itemSetId: string | null,
): Promise<RevisionFeedback | null> {
  if (assessment.assigned_scope !== "district" || !itemSetId || attempt.pass_back_count < 1) return null;
  const min = assessment.competency_pass_min_points;
  if (min === null) return null;

  // The option's final response: the item in the set with a rubric, the last
  // by position (the same rule as lib/competency/caseState.ts).
  const setItems = await db
    .select({ id: items.id, position: items.position, config: items.config })
    .from(items)
    .where(and(eq(items.assessment_id, assessment.id), eq(items.item_set_id, itemSetId)));
  const final = setItems
    .filter((i) => i.config?.rubric)
    .sort((a, b) => b.position - a.position)[0];
  if (!final) return null;

  const [response] = await db
    .select({ id: responses.id })
    .from(responses)
    .where(and(eq(responses.attempt_id, attempt.id), eq(responses.item_id, final.id)))
    .limit(1);
  if (!response) return null;

  const scoreRows = await db
    .select({ status: scores.status, rationale: scores.rationale, rubric_snapshot: scores.rubric_snapshot })
    .from(scores)
    .where(eq(scores.response_id, response.id))
    .orderBy(desc(scores.created_at));
  if (scoreRows.some((s) => s.status === "final")) return null;
  const old = scoreRows.find((s) => s.status === "superseded");
  if (!old) return null;

  const rubric: Rubric = old.rubric_snapshot ?? final.config!.rubric!;
  if (deriveCompetencyResult(rubric, old.rationale, min) !== "needs_revision") return null;

  const picks = new Map(
    ((old.rationale as { criterion_scores?: CriterionPick[] }).criterion_scores ?? []).map((p) => [p.criterion_id, p]),
  );
  const criteria = rubric.criteria.flatMap((c) => {
    const pick = picks.get(c.id);
    if (!pick) return [];
    const level =
      c.levels.find((l) => l.id === pick.level_id) ?? c.levels.find((l) => l.points === pick.points);
    if (!level) return [];
    const rationale = typeof pick.rationale === "string" ? pick.rationale.trim() : "";
    return [{ name: c.name, level_label: level.label, ...(rationale ? { rationale: clip(rationale) } : {}) }];
  });

  const [written] = await db
    .select({ text: response_feedback.text })
    .from(response_feedback)
    .where(eq(response_feedback.response_id, response.id))
    .limit(1);
  const note = written?.text.trim();

  if (criteria.length === 0 && !note) return null;
  return { [final.id]: { criteria, ...(note ? { note: clip(note) } : {}) } };
}
