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
 *
 * B1 slice 3 (docs/point-weighting-design.md, D2): a teacher-set, AI or
 * approved final whose `max_points` is no longer the question's maximum (its
 * points were changed after scoring) is RESCALED, not rescored: the same
 * fraction on the new maximum (`applyWeight`, full credit exactly the new
 * max), keeping its method, scorer, reviewer and rationale, plus
 * `rationale.rescaled_from`. The teacher's judgement stands; only its scale
 * moves. Criterion scores are untouched.
 */

import { attemptOneByAttempt } from "@/lib/scoring/attemptOne";
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
import { itemMaxPoints } from "@/lib/scoring/maxPoints";
import { applyWeight } from "@/lib/scoring/weight";

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
  /** B1 D2: "rescale" keeps a non-auto final's fraction on the new maximum. */
  kind: "rescore" | "rescale";
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
  /** B1 D2: teacher-set / AI finals put on the question's new points. */
  rescaled: number;
}

export interface RescorePlan {
  changes: RescoreChange[];
  /** Auto finals that change. */
  changed: number;
  /** Auto finals the current key scores the same. */
  unchanged: number;
  /** Non-auto finals that differ from the current key — left alone (D-2). */
  kept: number;
  /** B1 D2: non-auto finals whose maximum moved (points changed) — rescaled. */
  rescaled: number;
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
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const plan: RescorePlan = {
    changes: [],
    changed: 0,
    unchanged: 0,
    kept: 0,
    rescaled: 0,
    newly_scored: 0,
    unscorable: 0,
    students_changed: 0,
    questions: [],
  };
  const perItem = new Map<string, { changed: number; kept: number; rescaled: number }>();
  const bump = (itemId: string, field: "changed" | "kept" | "rescaled") => {
    const entry = perItem.get(itemId) ?? { changed: 0, kept: 0, rescaled: 0 };
    entry[field]++;
    perItem.set(itemId, entry);
  };
  const studentsChanged = new Set<string>();

  for (const response of responseRows) {
    const final = finalByResponse.get(response.id) ?? null;
    // B1 D2: a non-auto final on a question whose maximum moved keeps its
    // fraction on the new maximum, whatever the question's method.
    const question = itemById.get(response.item_id);
    if (question && final && final.method !== "auto" && final.max_points > 0) {
      const max = itemMaxPoints(question);
      if (final.max_points !== max) {
        const scaled = applyWeight(final.points, final.max_points, max);
        plan.rescaled++;
        plan.changes.push({
          kind: "rescale",
          response_id: response.id,
          attempt_id: response.attempt_id,
          item_id: response.item_id,
          from: final,
          points: scaled.points,
          max_points: scaled.max_points,
        });
        bump(question.id, "rescaled");
        studentsChanged.add(response.attempt_id);
        continue;
      }
    }
    const item = autoItems.get(response.item_id);
    if (!item) continue;
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
      kind: "rescore",
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
      if (change.kind === "rescale") {
        if (await writeRescale(tx, change, now)) {
          written++;
          writtenAttempts.add(change.attempt_id);
        } else {
          skipped++;
        }
        continue;
      }
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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B1 D2: one rescale, with the rescore's flip-is-the-read guard (the id, still
 * final, still the same method — a score changed in the meantime is skipped).
 * The new final is the old one on the new maximum: same method, scorer,
 * reviewer and rationale (criterion scores in rubric points untouched), plus
 * `rescaled_from`. False when the guard found nothing to replace.
 */
async function writeRescale(tx: Tx, change: RescoreChange, now: Date): Promise<boolean> {
  const from = change.from!;
  const [replaced] = await tx
    .update(scores)
    .set({ status: "superseded" })
    .where(and(eq(scores.id, from.id), eq(scores.status, "final"), eq(scores.method, from.method)))
    .returning();
  if (!replaced) return false;
  const rationale =
    replaced.rationale && typeof replaced.rationale === "object" ? (replaced.rationale as Record<string, unknown>) : {};
  const inserted = await tx
    .insert(scores)
    .values({
      response_id: change.response_id,
      method: replaced.method,
      points: change.points,
      max_points: change.max_points,
      rationale: {
        ...rationale,
        rescaled_from: { score_id: replaced.id, points: replaced.points, max_points: replaced.max_points },
      },
      scorer: replaced.scorer,
      status: "final",
      reviewed_by_sub: replaced.reviewed_by_sub,
      prompt_version: replaced.prompt_version,
      created_at: now,
    })
    .onConflictDoNothing()
    .returning({ id: scores.id });
  if (inserted.length === 0) return false;
  await tx.insert(attempt_events).values({
    attempt_id: change.attempt_id,
    kind: "score_changed",
    at: now,
    detail: {
      source: "rescale",
      response_id: change.response_id,
      item_id: change.item_id,
      from: replaced.points,
      to: change.points,
      max: change.max_points,
    },
  });
  return true;
}

/**
 * Sections with a live gradebook push that already carries one of these
 * attempts — the "Send again" note.
 *
 * U-25 slice 2: a push that sends attempt 1 (`basis = 'attempt_one'`) is not
 * moved by a rescore of an attempt that HAS an attempt 1: that score is built
 * from rows the rescore never touches (it only supersedes `final`s; attempt 1
 * comes from the round before the pass back). Such a pair is left out. An
 * attempt with no attempt 1 still sends its latest under that basis, so it
 * still counts.
 */
async function sectionsSentBefore(
  db: Db,
  assessmentId: string,
  attemptIds: string[],
): Promise<string[]> {
  if (attemptIds.length === 0) return [];
  const sent = await db
    .select({
      section_ps_id: gradebook_pushes.section_ps_id,
      basis: gradebook_pushes.basis,
      attempt_id: gradebook_push_scores.attempt_id,
    })
    .from(gradebook_push_scores)
    .innerJoin(gradebook_pushes, eq(gradebook_pushes.id, gradebook_push_scores.push_id))
    .where(
      and(
        eq(gradebook_pushes.assessment_id, assessmentId),
        inArray(gradebook_push_scores.attempt_id, attemptIds),
      ),
    );
  const attemptOnes = await attemptOneByAttempt(
    db,
    [...new Set(sent.filter((r) => r.basis === "attempt_one").map((r) => r.attempt_id))],
  );
  const rows = [
    ...new Set(
      sent
        .filter((r) => r.basis !== "attempt_one" || !attemptOnes.has(r.attempt_id))
        .map((r) => r.section_ps_id),
    ),
  ].map((section_ps_id) => ({ section_ps_id }));
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
