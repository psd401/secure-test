import { and, eq, isNull } from "drizzle-orm";
import {
  assessment_student_overrides,
  student_accommodations,
  type AssessmentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";
import { ruleForSections } from "@/lib/accommodations/sections";

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

/** The assessment fields the rule reads. */
export type AccommodationRule = Pick<
  AssessmentRow,
  "allowed_accommodations" | "construct_altering" | "assigned_scope"
> & {
  /** U-18: the class period's grants — everyone in the period gets them
   * (`ruleForSections`). Applied after the record, before exceptions. */
  grants?: readonly ToolSetting[];
};

/** A live entitlement or override row, reduced to what the rule reads. */
export interface ToolSetting {
  tool_id: string;
  value: string;
}

/**
 * U-16: the effective result plus WHY, for the teacher's "who gets what"
 * preview. Delivery reads only `enabled` / `constructAltering`.
 */
export interface ExplainedAccommodations extends EffectiveAccommodations {
  /** Tools an exception (override) turned on for this student. */
  grantedByException: string[];
  /** U-18: tools a class-period grant turned on (not already on the record). */
  grantedBySection: string[];
  /** Tools the record turned on and an Off exception switched off. */
  removedByException: string[];
  /** On the student's record (enabled) but not allowed on this assessment and
   * not granted by an exception — "on their record, not allowed here". */
  notAllowed: ToolSetting[];
}

/**
 * The rule itself, with no database (U-16 split it out so the delivery path
 * and the preview cannot disagree). `recordRows` are the student's LIVE
 * accommodation rows; `overrides` this assessment's exceptions for them.
 */
export function explainAccommodations(
  assessment: AccommodationRule,
  recordRows: readonly ToolSetting[],
  overrides: readonly ToolSetting[],
): ExplainedAccommodations {
  const allowed = new Set(
    ((assessment.allowed_accommodations ?? []) as string[]).filter(
      isValidAccommodationId,
    ),
  );

  // On the record and switched on, whether or not this assessment allows it.
  const onRecord = new Map<string, string>();
  for (const row of recordRows) {
    if (!isEnabledValue(row.value)) continue;
    // Two subjects granting the same tool with different values: first wins,
    // and both are "on", so the difference is a setting nuance rather than a
    // question of entitlement.
    if (!onRecord.has(row.tool_id)) onRecord.set(row.tool_id, row.value);
  }

  // An empty allowed list gives nothing, exceptions included — the assessment
  // permits no tool at all.
  if (allowed.size === 0) {
    return {
      enabled: {},
      constructAltering: [],
      grantedByException: [],
      grantedBySection: [],
      removedByException: [],
      notAllowed: [...onRecord]
        .filter(([toolId]) => isValidAccommodationId(toolId))
        .map(([tool_id, value]) => ({ tool_id, value })),
    };
  }

  const enabled: Record<string, string> = {};
  for (const [toolId, value] of onRecord) {
    if (allowed.has(toolId)) enabled[toolId] = value;
  }
  // U-18: class-period grants, for tools the period allows. A value already on
  // the student's record is the more specific setting and is kept.
  const bySection = new Set<string>();
  for (const g of assessment.grants ?? []) {
    if (!allowed.has(g.tool_id) || !isEnabledValue(g.value) || g.tool_id in enabled) continue;
    enabled[g.tool_id] = g.value;
    bySection.add(g.tool_id);
  }

  // On a teacher-assigned assessment the teacher's override outranks the
  // allowed list; on one assigned from above, it does not.
  const overrideMayExceedAllowed = assessment.assigned_scope === "teacher";
  const grantedBeyondAllowed: string[] = [];
  const granted = new Set<string>();
  const removed = new Set<string>();

  for (const override of overrides) {
    const withinAllowed = allowed.has(override.tool_id);
    if (!withinAllowed && !overrideMayExceedAllowed) continue;
    // An id outside the catalog cannot be honoured by any client, so it is
    // dropped whatever the scope — this is a shape check, not a policy one.
    if (!isValidAccommodationId(override.tool_id)) continue;

    if (isEnabledValue(override.value)) {
      enabled[override.tool_id] = override.value;
      granted.add(override.tool_id);
      removed.delete(override.tool_id);
      if (!withinAllowed) grantedBeyondAllowed.push(override.tool_id);
    } else {
      // Revocation applies regardless of scope: withdrawing a support for one
      // student never threatens comparability.
      if (override.tool_id in enabled) removed.add(override.tool_id);
      delete enabled[override.tool_id];
      granted.delete(override.tool_id);
    }
  }

  const flagged = new Set(
    ((assessment.construct_altering ?? []) as string[]).filter((id) => id in enabled),
  );
  for (const id of grantedBeyondAllowed) {
    if (id in enabled) flagged.add(id);
  }

  return {
    enabled,
    constructAltering: [...flagged],
    grantedByException: [...granted],
    grantedBySection: [...bySection].filter((id) => !granted.has(id) && id in enabled),
    removedByException: [...removed].filter((id) => onRecord.has(id) || bySection.has(id)),
    notAllowed: [...onRecord]
      .filter(([toolId]) => isValidAccommodationId(toolId) && !allowed.has(toolId) && !granted.has(toolId))
      .map(([tool_id, value]) => ({ tool_id, value })),
  };
}

export async function resolveEffectiveAccommodations(
  db: Db,
  assessment: AssessmentRow,
  studentId: string,
  /** U-17 (docs/coteach-and-section-accommodations-design.md): co-teachers'
   * overlay rows for the same child (`coTeacherRecordStudentIds`), in
   * order. Their live records are UNIONED with the owner's (D-1, On wins);
   * the owner's are read first, so the owner's value wins a same-tool
   * conflict (13.2). Exceptions are always `studentId`'s — one place per
   * test. Replaces the 2026-09-22 only-when-empty fallback. */
  coTeacherStudentIds: readonly string[] = [],
  /** U-18: the student's class periods for this attempt (`sectionsForAttempt`). */
  sectionPsIds: readonly string[] = [],
): Promise<EffectiveAccommodations> {
  const rule = ruleForSections(assessment, sectionPsIds);
  // Short-circuit kept from before U-16: no allowed tool, no queries.
  if ((rule.allowed_accommodations as string[]).length === 0) return { enabled: {}, constructAltering: [] };

  // Live rows only — removed_at is a soft delete kept for the audit trail, and
  // a withdrawn accommodation must not keep being applied.
  //
  // Unioned across SUBJECTS rather than filtered to one, because an assessment
  // has no subject field to filter by. That is deliberately permissive at this
  // layer: the assessment's allowed list is the thing that narrows, and it is
  // the narrowing a teacher actually reasons about. A student granted a tool in
  // Mathematics gets it on any assessment whose author permitted that tool.
  const liveRowsOf = (id: string) =>
    db
      .select({ tool_id: student_accommodations.tool_id, value: student_accommodations.value })
      .from(student_accommodations)
      .where(
        and(
          eq(student_accommodations.student_id, id),
          isNull(student_accommodations.removed_at),
        ),
      );
  const studentRows = await liveRowsOf(studentId);
  for (const id of coTeacherStudentIds) {
    studentRows.push(...(await liveRowsOf(id)));
  }

  const overrides = await db
    .select({
      tool_id: assessment_student_overrides.tool_id,
      value: assessment_student_overrides.value,
    })
    .from(assessment_student_overrides)
    .where(
      and(
        eq(assessment_student_overrides.assessment_id, assessment.id),
        eq(assessment_student_overrides.student_id, studentId),
      ),
    );

  const { enabled, constructAltering } = explainAccommodations(rule, studentRows, overrides);
  return { enabled, constructAltering };
}
