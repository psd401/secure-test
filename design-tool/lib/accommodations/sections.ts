import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { roster_enrollments, test_sessions, type AssessmentRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";
import { isEnabledValue, type AccommodationRule, type ToolSetting } from "@/lib/accommodations/effective";
import { enrollmentIsCurrent } from "@/lib/roster/queries";

type Db = ReturnType<typeof getDb>;

/**
 * U-18 (docs/coteach-and-section-accommodations-design.md): accommodations
 * by class period, stored on `assessments.section_accommodations`.
 *
 *   - `allowed`: the period's own allowed list, REPLACING the test's for that
 *     period (D-5); `null` = use the test's. On a school / district-assigned
 *     test it may only narrow the test's list (checked on write, and again
 *     when resolving, so shrinking the test's list later cannot widen it).
 *   - `grants`: tools everyone in the period gets (D-4), each one the period
 *     allows (13.8); they sit below per-student exceptions (D-6).
 */
export interface SectionAccommodation {
  allowed: string[] | null;
  grants: ToolSetting[];
}
export type SectionAccommodations = Record<string, SectionAccommodation>;

const AccommodationId = z.string().refine(isValidAccommodationId, { message: "unknown_accommodation_id" });

export const SectionAccommodationsSchema = z
  .record(
    z.string().min(1).max(64),
    z.object({
      allowed: z.array(AccommodationId).max(100).nullable(),
      grants: z
        .array(z.object({ tool_id: AccommodationId, value: z.string().trim().min(1).max(100) }))
        .max(100),
    }),
  )
  .refine((v) => Object.keys(v).length <= 100, { message: "too_many_sections" });

type RuleSource = Pick<AssessmentRow, "allowed_accommodations" | "assigned_scope"> & {
  section_accommodations?: SectionAccommodations | null;
};

export type SectionValidation =
  | { ok: true }
  | {
      ok: false;
      error: "section_allowed_must_be_subset" | "grant_not_allowed" | "grant_value_off" | "grant_repeated";
      section_ps_id: string;
      tool_id: string;
    };

/** Write-time invariants for a whole `section_accommodations` value. */
export function validateSectionAccommodations(
  value: SectionAccommodations,
  testAllowed: readonly string[],
  assignedScope: string,
): SectionValidation {
  const test = new Set(testAllowed);
  for (const [sectionPsId, cfg] of Object.entries(value)) {
    if (assignedScope !== "teacher" && cfg.allowed) {
      const outside = cfg.allowed.find((id) => !test.has(id));
      if (outside) return { ok: false, error: "section_allowed_must_be_subset", section_ps_id: sectionPsId, tool_id: outside };
    }
    const allowed = new Set(cfg.allowed ?? testAllowed);
    const seen = new Set<string>();
    for (const g of cfg.grants) {
      if (seen.has(g.tool_id)) return { ok: false, error: "grant_repeated", section_ps_id: sectionPsId, tool_id: g.tool_id };
      seen.add(g.tool_id);
      if (!allowed.has(g.tool_id)) return { ok: false, error: "grant_not_allowed", section_ps_id: sectionPsId, tool_id: g.tool_id };
      if (!isEnabledValue(g.value)) return { ok: false, error: "grant_value_off", section_ps_id: sectionPsId, tool_id: g.tool_id };
    }
  }
  return { ok: true };
}

/** U-20 slice 2: the period settings for the periods in `keep` only (a
 * shared copy keeps the recipient's own periods). */
export function keepPeriods(config: SectionAccommodations, keep: ReadonlySet<string>): SectionAccommodations {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([psId]) => keep.has(psId)));
}

/**
 * The rule for a student whose class periods (on this test) are
 * `sectionPsIds`. Periods without a configuration contribute the test's own
 * list; when NONE of them is configured the test's list stands alone. Several
 * configured periods (D-8: no sitting section to choose by) union their
 * allowed lists and their grants (first value per tool wins).
 */
export function ruleForSections<T extends RuleSource & Pick<AssessmentRow, "construct_altering">>(
  assessment: T,
  sectionPsIds: readonly string[],
): AccommodationRule {
  const testAllowed = ((assessment.allowed_accommodations ?? []) as string[]).filter(isValidAccommodationId);
  const configs = sectionPsIds
    .map((id) => assessment.section_accommodations?.[id])
    .filter((c): c is SectionAccommodation => !!c);
  const base = {
    construct_altering: assessment.construct_altering,
    assigned_scope: assessment.assigned_scope,
  };
  if (configs.length === 0) return { ...base, allowed_accommodations: testAllowed, grants: [] };

  const narrowOnly = assessment.assigned_scope !== "teacher";
  const test = new Set(testAllowed);
  const allowed = new Set<string>();
  // A configured period's list, plus the test's list for any listed period
  // that has no configuration of its own.
  if (configs.length < sectionPsIds.length) for (const id of testAllowed) allowed.add(id);
  for (const c of configs) {
    for (const id of c.allowed ?? testAllowed) {
      if (!isValidAccommodationId(id)) continue;
      if (narrowOnly && !test.has(id)) continue;
      allowed.add(id);
    }
  }
  const grants: ToolSetting[] = [];
  for (const c of configs) {
    for (const g of c.grants) {
      if (!allowed.has(g.tool_id) || grants.some((x) => x.tool_id === g.tool_id)) continue;
      grants.push({ tool_id: g.tool_id, value: g.value });
    }
  }
  return { ...base, allowed_accommodations: [...allowed], grants };
}

/** Configured class periods the student is CURRENTLY enrolled in (D-8). */
export async function configuredSectionsOf(
  db: Db,
  assessment: RuleSource,
  rosterPsIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const configured = Object.keys(assessment.section_accommodations ?? {});
  if (configured.length === 0 || rosterPsIds.length === 0) return out;
  const rows = await db
    .select({ ps_id: roster_enrollments.student_ps_id, section: roster_enrollments.section_ps_id })
    .from(roster_enrollments)
    .where(
      and(
        enrollmentIsCurrent,
        inArray(roster_enrollments.student_ps_id, [...rosterPsIds]),
        inArray(roster_enrollments.section_ps_id, configured),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.ps_id) ?? [];
    if (!list.includes(r.section)) list.push(r.section);
    out.set(r.ps_id, list.sort());
  }
  return out;
}

/**
 * D-8 at delivery: the attempt's sitting section when the sitting names one
 * (whether or not that period is configured — an unconfigured one means the
 * test's rule), else every configured period the student is enrolled in.
 */
export async function sectionsForAttempt(
  db: Db,
  assessment: RuleSource,
  attempt: { test_session_id: string | null },
  rosterPsId: string | null,
): Promise<string[]> {
  if (Object.keys(assessment.section_accommodations ?? {}).length === 0) return [];
  if (attempt.test_session_id) {
    const [sitting] = await db
      .select({ section: test_sessions.section_ps_id })
      .from(test_sessions)
      .where(eq(test_sessions.id, attempt.test_session_id))
      .limit(1);
    if (sitting?.section) return [sitting.section];
  }
  if (!rosterPsId) return [];
  return (await configuredSectionsOf(db, assessment, [rosterPsId])).get(rosterPsId) ?? [];
}
