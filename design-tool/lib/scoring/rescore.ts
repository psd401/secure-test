/**
 * Rescore with the current key (docs/rescore-after-key-change-design.md, E11).
 *
 * Auto-scored items are scored once, at hand-in, and `runAutoScoringPass`
 * never touches a response that already has a final — so a key fixed after
 * students handed in never reached their scores. This module re-runs the same
 * `scoreResponse` against the SAVED keys and corrects the auto finals that
 * now differ.
 *
 * Two halves:
 * - `planRescore` is pure: it says, for the rows it is given, which auto
 *   finals would change, which unscored answers would now score, and how many
 *   teacher-set scores differ from the new key but stay (D-2). The Results
 *   page runs it on rows `buildResults` already loaded (the button's count,
 *   D-1: active only when a key change would change a score); the route runs
 *   it for the dry run and again inside the write.
 * - `applyRescore` writes the plan in one transaction with the Change score
 *   pattern (`lib/api/changeScore.ts`): flip the final to `superseded` with
 *   RETURNING — the flip is the read, guarded on the id and `method = auto`,
 *   so a score a teacher changed in the meantime is skipped rather than
 *   overwritten — then insert the new `auto` final carrying
 *   `rationale.changed_from` + `rationale.rescored`, and a `score_changed`
 *   event with `detail.source = "rescore"`.
 *
 * Only handed-in, non-practice attempts are in scope: an in-progress attempt
 * is scored at its own hand-in, against the current key already.
 */

import { and, eq, inArray } from "drizzle-orm";
import { ItemResponseSchema } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import {
  attempt_events,
  attempts,
  gradebook_push_scores,
  gradebook_pushes,
  items,
  responses,
  roster_sections,
  scores,
  type ItemRow,
  type ItemType,
} from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { sectionLabel } from "@/lib/roster/teacherRoster";
import { scoreResponse } from "@/lib/scoring/auto";

type Db = ReturnType<typeof getDb>;

export interface RescoreResponseInput {
  id: string;
  attempt_id: string;
  item_id: string;
  response: unknown;
}

export interface RescoreFinalInput {
  id: string;
  points: number;
  max_points: number;
  method: string;
}

export interface RescoreChange {
  response_id: string;
  attempt_id: string;
  item_id: string;
  /** The auto final being replaced; absent when the answer was never scored. */
  from: RescoreFinalInput | null;
  points: number;
  max_points: number;
}

export interface RescoreQuestion {
  item_id: string;
  position: number;
  /** Answers whose score changes or that are scored for the first time. */
  changed: number;
  /** Teacher-set / AI finals that differ from the new key and stay (D-2). */
  kept: number;
}

export interface RescorePlan {
  changes: RescoreChange[];
  /** Auto finals that change. */
  changed: number;
  /** Auto finals the current key scores the same. */
  unchanged: number;
  /** Non-auto finals that differ from the current key — left alone (D-2). */
  kept: number;
  /** Answers with no final that the current key now scores (a key added after hand-in). */
  newly_scored: number;
  /** Answers with no final that are still unscorable. */
  unscorable: number;
  /** Distinct attempts with at least one change — the button's count. */
  students_changed: number;
  /** Questions with a change or a kept difference, in item order. */
  questions: RescoreQuestion[];
}

/**
 * The pure plan. `responseRows` must already be limited to handed-in,
 * non-practice attempts; `finalByResponse` holds each response's `final`.
 */
export function planRescore(
  itemRows: ItemRow[],
  responseRows: RescoreResponseInput[],
  finalByResponse: Map<string, RescoreFinalInput>,
): RescorePlan {
  const autoItems = new Map(
    itemRows
      .filter((i) => effectiveScoringMethod(i.type as ItemType, i.config) === "auto")
      .map((i) => [i.id, i]),
  );
  const plan: RescorePlan = {
    changes: [],
    changed: 0,
    unchanged: 0,
    kept: 0,
    newly_scored: 0,
    unscorable: 0,
    students_changed: 0,
    questions: [],
  };
  const perItem = new Map<string, { changed: number; kept: number }>();
  const bump = (itemId: string, field: "changed" | "kept") => {
    const entry = perItem.get(itemId) ?? { changed: 0, kept: 0 };
    entry[field]++;
    perItem.set(itemId, entry);
  };
  const studentsChanged = new Set<string>();

  for (const response of responseRows) {
    const item = autoItems.get(response.item_id);
    if (!item) continue;
    const final = finalByResponse.get(response.id) ?? null;
    const parsed = ItemResponseSchema.safeParse(response.response);
    const result = parsed.success ? scoreResponse(item, parsed.data) : null;

    if (!final) {
      if (!result) {
        plan.unscorable++;
        continue;
      }
      plan.newly_scored++;
    } else {
      // Unscorable under the current key (the key was cleared): nothing to
      // put in its place, so the existing score stands.
      if (!result) {
        plan.unchanged++;
        continue;
      }
      const same = result.points === final.points && result.max_points === final.max_points;
      if (final.method !== "auto") {
        if (!same) {
          plan.kept++;
          bump(item.id, "kept");
        }
        continue;
      }
      if (same) {
        plan.unchanged++;
        continue;
      }
      plan.changed++;
    }
    plan.changes.push({
      response_id: response.id,
      attempt_id: response.attempt_id,
      item_id: response.item_id,
      from: final,
      points: result.points,
      max_points: result.max_points,
    });
    bump(item.id, "changed");
    studentsChanged.add(response.attempt_id);
  }

  plan.students_changed = studentsChanged.size;
  plan.questions = itemRows
    .filter((i) => perItem.has(i.id))
    .sort((a, b) => a.position - b.position)
    .map((i) => ({ item_id: i.id, position: i.position, ...perItem.get(i.id)! }));
  return plan;
}

type Executor = Pick<Db, "select">;

/** Load the rows the plan needs for one assessment and plan it. */
export async function loadRescorePlan(db: Executor, assessmentId: string): Promise<RescorePlan> {
  const itemRows = await db.select().from(items).where(eq(items.assessment_id, assessmentId));
  const handedIn = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.assessment_id, assessmentId),
        eq(attempts.status, "submitted"),
        eq(attempts.practice, false),
      ),
    );
  if (handedIn.length === 0 || itemRows.length === 0) {
    return planRescore(itemRows, [], new Map());
  }
  const responseRows = await db
    .select({
      id: responses.id,
      attempt_id: responses.attempt_id,
      item_id: responses.item_id,
      response: responses.response,
    })
    .from(responses)
    .where(
      inArray(
        responses.attempt_id,
        handedIn.map((a) => a.id),
      ),
    );
  const finalRows =
    responseRows.length > 0
      ? await db
          .select({
            id: scores.id,
            response_id: scores.response_id,
            points: scores.points,
            max_points: scores.max_points,
            method: scores.method,
          })
          .from(scores)
          .where(
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              eq(scores.status, "final"),
            ),
          )
      : [];
  return planRescore(itemRows, responseRows, new Map(finalRows.map((f) => [f.response_id, f])));
}

export interface RescoreResult {
  plan: RescorePlan;
  /** Changes written. Lower than the plan's when a score moved under us. */
  written: number;
  /** Planned changes skipped because the final changed between plan and write. */
  skipped_conflict: number;
  /** Labels of sections already sent to a gradebook that hold a changed student (D-3). */
  sections_sent_before: string[];
}

/**
 * Plan and write in one transaction. `staffSub` is recorded as the reviewer
 * of every new row (the teacher who pressed the button); the scorer stays
 * `auto`, because the key did the scoring.
 */
export async function applyRescore(
  db: Db,
  assessmentId: string,
  staffSub: string,
  options: { now?: Date } = {},
): Promise<RescoreResult> {
  const now = options.now ?? new Date();
  const outcome = await db.transaction(async (tx) => {
    const plan = await loadRescorePlan(tx, assessmentId);
    let written = 0;
    let skipped = 0;
    const writtenAttempts = new Set<string>();

    for (const change of plan.changes) {
      let replacedId: string | null = null;
      if (change.from) {
        const [replaced] = await tx
          .update(scores)
          .set({ status: "superseded" })
          .where(
            and(
              eq(scores.id, change.from.id),
              eq(scores.status, "final"),
              eq(scores.method, "auto"),
            ),
          )
          .returning({ id: scores.id });
        if (!replaced) {
          skipped++;
          continue;
        }
        replacedId = replaced.id;
      }

      const inserted = await tx
        .insert(scores)
        .values({
          response_id: change.response_id,
          method: "auto",
          points: change.points,
          max_points: change.max_points,
          rationale: change.from
            ? {
                rescored: true,
                changed_from: {
                  score_id: replacedId,
                  points: change.from.points,
                  method: change.from.method,
                  scorer: "auto",
                },
              }
            : { rescored: true },
          scorer: "auto",
          status: "final",
          reviewed_by_sub: staffSub,
          created_at: now,
        })
        // A first score can race a concurrent scoring pass on the
        // one-final-per-response index; the other pass's row stands.
        .onConflictDoNothing()
        .returning({ id: scores.id });
      if (inserted.length === 0) {
        skipped++;
        continue;
      }

      await tx.insert(attempt_events).values({
        attempt_id: change.attempt_id,
        kind: "score_changed",
        at: now,
        detail: {
          source: "rescore",
          response_id: change.response_id,
          item_id: change.item_id,
          from: change.from ? change.from.points : null,
          to: change.points,
          max: change.max_points,
        },
      });
      written++;
      writtenAttempts.add(change.attempt_id);
    }
    return { plan, written, skipped, writtenAttempts };
  });

  return {
    plan: outcome.plan,
    written: outcome.written,
    skipped_conflict: outcome.skipped,
    sections_sent_before: await sectionsSentBefore(db, assessmentId, [...outcome.writtenAttempts]),
  };
}

/** Sections with a live gradebook push that already carries one of these attempts. */
async function sectionsSentBefore(
  db: Db,
  assessmentId: string,
  attemptIds: string[],
): Promise<string[]> {
  if (attemptIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ section_ps_id: gradebook_pushes.section_ps_id })
    .from(gradebook_push_scores)
    .innerJoin(gradebook_pushes, eq(gradebook_pushes.id, gradebook_push_scores.push_id))
    .where(
      and(
        eq(gradebook_pushes.assessment_id, assessmentId),
        inArray(gradebook_push_scores.attempt_id, attemptIds),
      ),
    );
  if (rows.length === 0) return [];
  const sections = await db
    .select()
    .from(roster_sections)
    .where(
      inArray(
        roster_sections.ps_id,
        rows.map((r) => r.section_ps_id),
      ),
    );
  const labelById = new Map(sections.map((s) => [s.ps_id, sectionLabel(s)]));
  return rows.map((r) => labelById.get(r.section_ps_id) ?? r.section_ps_id).sort();
}
