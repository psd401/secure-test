/**
 * Pass back a class by section from the Test sessions list
 * (docs/bulk-pass-back-and-corrections-design.md, slice 1, D-1 / 4.1).
 *
 * The Results page sends the ids its section filter shows; the Test sessions
 * list has no results rows in hand, so the server resolves the section itself
 * — from `buildResults`, so a section here is EXACTLY the Results filter's
 * (the owner's roster overlay, the same labels, `NO_SECTION` for rows with
 * none). One definition, two surfaces, no drift between what the picker says
 * and what Results shows.
 */

import { and, eq, inArray } from "drizzle-orm";
import { attempts, type AssessmentRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import { attemptIsTimed } from "@/lib/api/attemptDeadline";
import { buildResults } from "@/lib/scoring/results";
import { NO_SECTION } from "@/lib/scoring/sectionFilter";

type Db = ReturnType<typeof getDb>;

export interface SectionPassBackTargets {
  /** The Results filter's value: a section label, or `NO_SECTION`. */
  section: string;
  attempt_ids: string[];
  /** Any of them needs a new deadline (`attemptIsTimed`). */
  timed: boolean;
}

/** Handed-in, non-practice attempts grouped by resolved section, sorted by
 * label with "no section" last. Sections with nobody handed in are left out. */
export async function sectionPassBackTargets(
  db: Db,
  assessment: AssessmentRow,
): Promise<SectionPassBackTargets[]> {
  const results = await buildResults(assessment.id);
  const submitted = results.rows.filter((r) => r.status === "submitted");
  if (submitted.length === 0) return [];

  const rows = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.assessment_id, assessment.id),
        inArray(
          attempts.id,
          submitted.map((r) => r.attempt_id),
        ),
      ),
    );
  const timedIds = new Set(rows.filter((a) => attemptIsTimed(a, assessment)).map((a) => a.id));

  const bySection = new Map<string, SectionPassBackTargets>();
  for (const r of submitted) {
    const section = r.student.section || NO_SECTION;
    const entry = bySection.get(section) ?? { section, attempt_ids: [], timed: false };
    entry.attempt_ids.push(r.attempt_id);
    entry.timed ||= timedIds.has(r.attempt_id);
    bySection.set(section, entry);
  }
  return [...bySection.values()].sort((a, b) => {
    if (a.section === NO_SECTION) return 1;
    if (b.section === NO_SECTION) return -1;
    return a.section.localeCompare(b.section);
  });
}
