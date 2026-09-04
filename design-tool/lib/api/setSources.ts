import { and, eq } from "drizzle-orm";
import type { DeliveryItemSet, TeacherItemSet } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { attempts, items, responses } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

// E12 slice 2 (docs/e12-per-student-stimulus-design.md): a set whose
// `source_item_id` names an essay / short-text question elsewhere shows
// each student THEIR OWN saved answer to it, resolved here at delivery.
// Order (decisions D-1 and D-4): the student's saved answer on the source
// assessment — whatever that attempt's status; then the outline they
// wrote inline on THIS attempt (a response keyed by the source item's id);
// then nothing, which the bundle flags as `source_missing` so the client
// offers the writing area. Nothing per student is stored for the set.

export type SourceOrigin = "source" | "inline" | "missing";

export interface ResolvedSource {
  text: string | null;
  origin: SourceOrigin;
}

function textOf(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as { type?: unknown; text?: unknown };
  if ((r.type === "essay" || r.type === "short_text") && typeof r.text === "string" && r.text.trim()) {
    return r.text;
  }
  return null;
}

export async function resolveSourceText(
  db: Db,
  sourceItemId: string,
  studentId: string,
  attemptId: string,
): Promise<ResolvedSource> {
  const [src] = await db
    .select({ assessment_id: items.assessment_id })
    .from(items)
    .where(eq(items.id, sourceItemId))
    .limit(1);
  if (src) {
    const [sourceAttempt] = await db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.assessment_id, src.assessment_id), eq(attempts.student_id, studentId)))
      .limit(1);
    if (sourceAttempt) {
      const [row] = await db
        .select({ response: responses.response })
        .from(responses)
        .where(and(eq(responses.attempt_id, sourceAttempt.id), eq(responses.item_id, sourceItemId)))
        .limit(1);
      const text = textOf(row?.response);
      if (text) return { text, origin: "source" };
    }
  }
  const [inline] = await db
    .select({ response: responses.response })
    .from(responses)
    .where(and(eq(responses.attempt_id, attemptId), eq(responses.item_id, sourceItemId)))
    .limit(1);
  const inlineText = textOf(inline?.response);
  if (inlineText) return { text: inlineText, origin: "inline" };
  return { text: null, origin: "missing" };
}

/** The lead-in the teacher wrote, then the student's own words. */
export function composeStimulus(leadIn: string, text: string | null): string {
  const lead = leadIn.trim();
  if (!text) return lead;
  return lead ? `${lead}\n\n${text}` : text;
}

/**
 * Per-student resolution for a delivery bundle: sets without a source pass
 * through; a set with one gets its stimulus composed, or `source_missing`.
 */
export async function applySourcesToSets(
  db: Db,
  sets: readonly TeacherItemSet[],
  sourceOfSet: ReadonlyMap<string, string | null>,
  studentId: string,
  attemptId: string,
): Promise<DeliveryItemSet[]> {
  const out: DeliveryItemSet[] = [];
  for (const set of sets) {
    const sourceItemId = sourceOfSet.get(set.id) ?? null;
    const { source: _teacherOnly, ...plain } = set;
    if (!sourceItemId) {
      out.push(plain);
      continue;
    }
    const resolved = await resolveSourceText(db, sourceItemId, studentId, attemptId);
    if (resolved.origin === "source") {
      out.push({ ...plain, stimulus: composeStimulus(set.stimulus, resolved.text) });
      continue;
    }
    // Inline or missing: the lead-in alone, plus where to write (slice 3).
    out.push({
      ...plain,
      stimulus: composeStimulus(set.stimulus, null),
      inline_item_id: sourceItemId,
      ...(resolved.origin === "inline" ? { inline_text: resolved.text ?? "" } : { source_missing: true }),
    });
  }
  return out;
}
