import { and, eq, isNull } from "drizzle-orm";
import {
  assessment_student_overrides,
  student_accommodations,
  type AssessmentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 62: works out which accommodations a specific student actually gets on
 * a specific assessment.
 *
 * Everything needed for this has existed for slices — the TIDE import, the
 * 55-entry OSPI catalog, the per-assessment overrides UI — and none of it has
 * ever reached a student, because until the student principal there was no
 * identity to resolve against. The delivery bundle shipped the assessment's
 * allowed list and nothing else, so a child with a documented IEP accommodation
 * would have sat the test without it.
 *
 * Three inputs, in increasing order of specificity:
 *
 *   1. assessment.allowed_accommodations — what this assessment permits at all.
 *      This is the construct-validity decision: read-aloud on a reading test
 *      measures something other than reading, so an assessment may forbid it
 *      for everyone.
 *   2. student_accommodations — what this child is entitled to, imported from
 *      TIDE and editable by the teacher. Per (student, subject, tool).
 *   3. assessment_student_overrides — what this teacher decided for this child
 *      on this assessment specifically.
 *
 * How the allowed list interacts with an override depends on WHO ASSIGNED the
 * assessment (slice 63):
 *
 *   - assigned_scope "teacher" — the override WINS, even for a tool the allowed
 *     list omits. It is the teacher's own assessment; they own the construct
 *     decision, and they are the person who knows this child. Making them edit
 *     the assessment-wide list to give one student a support would push them to
 *     widen it for everyone.
 *
 *   - assigned_scope "school" or "district" — the allowed list GATES the
 *     override. The construct decision was made above the teacher, and a
 *     per-student override silently crossing it would invalidate a score that
 *     the school or district is going to compare across classrooms.
 *
 * An Off override revokes in BOTH cases. Withdrawing a support for one student
 * on one assessment never threatens comparability, and the teacher is always
 * the one closest to the child.
 */
export interface EffectiveAccommodations {
  /** tool_id → the setting value the client should apply. */
  enabled: Record<string, string>;
  /**
   * The subset of `enabled` whose use should be recorded against the score.
   *
   * Two sources. The assessment's own construct_altering list, and — on a
   * teacher-assigned assessment — any tool an override granted that the allowed
   * list does not name. The second is the conservative reading: nobody vetted
   * that tool against this assessment's construct, so treating it as
   * construct-altering keeps the score honest rather than assuming it is
   * harmless. A teacher who disagrees adds the tool to the assessment's allowed
   * list, which is the vetting step.
   */
  constructAltering: string[];
}

/**
 * TIDE records a setting for every tool, so "has a row" does not mean "gets the
 * tool" — most rows say Off. These are the values that mean not-enabled.
 *
 * Matched case-insensitively against the TIDE vocabulary
 * (lib/accommodations/tide-catalog.json), where the off-ish values observed are
 * "Off" and "None (Default)". Anything else — "On", "Stimuli+Items", "Black on
 * Rose" — is a real setting and is passed through as-is, because the value
 * itself is what the client needs.
 */
const DISABLED_VALUES = new Set(["", "off", "none", "none (default)", "default"]);

export function isEnabledValue(value: string): boolean {
  return !DISABLED_VALUES.has(value.trim().toLowerCase());
}

export async function resolveEffectiveAccommodations(
  db: Db,
  assessment: AssessmentRow,
  studentId: string,
): Promise<EffectiveAccommodations> {
  const allowed = new Set(
    ((assessment.allowed_accommodations ?? []) as string[]).filter(
      isValidAccommodationId,
    ),
  );
  if (allowed.size === 0) return { enabled: {}, constructAltering: [] };

  // Live rows only — removed_at is a soft delete kept for the audit trail, and
  // a withdrawn accommodation must not keep being applied.
  //
  // Unioned across SUBJECTS rather than filtered to one, because an assessment
  // has no subject field to filter by. That is deliberately permissive at this
  // layer: the assessment's allowed list is the thing that narrows, and it is
  // the narrowing a teacher actually reasons about. A student granted a tool in
  // Mathematics gets it on any assessment whose author permitted that tool.
  const studentRows = await db
    .select()
    .from(student_accommodations)
    .where(
      and(
        eq(student_accommodations.student_id, studentId),
        isNull(student_accommodations.removed_at),
      ),
    );

  const enabled: Record<string, string> = {};
  for (const row of studentRows) {
    if (!allowed.has(row.tool_id)) continue;
    if (!isEnabledValue(row.value)) continue;
    // Two subjects granting the same tool with different values: first wins,
    // and both are "on", so the difference is a setting nuance rather than a
    // question of entitlement.
    if (!(row.tool_id in enabled)) enabled[row.tool_id] = row.value;
  }

  const overrides = await db
    .select()
    .from(assessment_student_overrides)
    .where(
      and(
        eq(assessment_student_overrides.assessment_id, assessment.id),
        eq(assessment_student_overrides.student_id, studentId),
      ),
    );

  // On a teacher-assigned assessment the teacher's override outranks the
  // allowed list; on one assigned from above, it does not.
  const overrideMayExceedAllowed = assessment.assigned_scope === "teacher";
  const grantedBeyondAllowed: string[] = [];

  for (const override of overrides) {
    const withinAllowed = allowed.has(override.tool_id);
    if (!withinAllowed && !overrideMayExceedAllowed) continue;
    // An id outside the catalog cannot be honoured by any client, so it is
    // dropped whatever the scope — this is a shape check, not a policy one.
    if (!isValidAccommodationId(override.tool_id)) continue;

    if (isEnabledValue(override.value)) {
      enabled[override.tool_id] = override.value;
      if (!withinAllowed) grantedBeyondAllowed.push(override.tool_id);
    } else {
      // Revocation applies regardless of scope: withdrawing a support for one
      // student never threatens comparability.
      delete enabled[override.tool_id];
    }
  }

  const flagged = new Set(
    ((assessment.construct_altering ?? []) as string[]).filter((id) => id in enabled),
  );
  for (const id of grantedBeyondAllowed) {
    if (id in enabled) flagged.add(id);
  }

  return { enabled, constructAltering: [...flagged] };
}
