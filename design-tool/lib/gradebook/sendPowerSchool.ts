// "Send to gradebook" → PowerTeacher Pro (docs/gradebook-push-design.md,
// "The send"). The route authorizes (authorizeSend) and validates the body;
// this is everything after: select, create-or-reuse, write, record.
//
// One destination, one section (D-1). Only fully scored attempts (D-3),
// points only against the assessment's max (D-4), a re-send reuses the stored
// assignment and skips unchanged rows (D-7), the destination is remembered per
// (teacher, section) (D-5), the publish option is the category's own (8.2),
// and a passed-back attempt's earlier score stays until the next send
// overwrites it — the summary says so (8.3).
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  attempt_events,
  attempts,
  gradebook_push_scores,
  gradebook_pushes,
  gradebook_section_prefs,
  type AssessmentRow,
  type GradebookPushRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { isUniqueViolation } from "@/lib/db/isUniqueViolation";
import { log } from "@/lib/log";
import {
  loadSectionCandidates,
  missingPowerSchoolIds,
  planSend,
  type PlannedWrite,
  type PriorScore,
  type SectionIds,
} from "./mapping";
import { GradebookHttpError, type PowerSchoolClient } from "./powerschool";
import { buildAssignmentCreateBody, truncateAssignmentName } from "./powerschoolPayloads";
import {
  buildScoreWriteBodyUnconfirmed,
  parseScoreWriteResponseUnconfirmed,
} from "./powerschoolScoreBodyUnconfirmed";
import { HELD_BACK_REASONS, type HeldBackReason, type SendFailure, type SendSummary } from "./types";

type Db = ReturnType<typeof getDb>;

/** A first send's claim row older than this is taken to be a crashed send. */
export const CLAIM_STALE_MS = 2 * 60_000;

const TZ = "America/Los_Angeles";

/** Today's date in the district's time zone, `YYYY-MM-DD` (8.1's default). */
export function todayPacific(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * A PowerSchool error body with every run of 4+ digits masked, for the log.
 * A 409 names the fields it refused and may echo a student's DCID; the log
 * contract (lib/log.ts) forbids student identifiers, so ids are masked while
 * the field names and messages — the useful part — survive. The API response
 * carries the body verbatim; the log does not.
 */
export function maskIdsForLog(body: string): string {
  return body.replace(/\d{4,}/g, "#").slice(0, 2000);
}

export interface PowerSchoolSendInput {
  assessment: AssessmentRow;
  section: SectionIds;
  teacher: { sub: string; email: string; users_dcid: string | null };
  actor_sub: string | null;
  category_id: string;
  name: string;
  due_date: string;
}

export type SendOutcome =
  | { ok: true; summary: SendSummary }
  | { ok: false; status: number; error: string; detail?: unknown };

function emptyReasons(): Record<HeldBackReason, number> {
  return Object.fromEntries(HELD_BACK_REASONS.map((r) => [r, 0])) as Record<HeldBackReason, number>;
}

function failureReason(err: unknown): string {
  if (err instanceof GradebookHttpError) {
    // A 409 is PowerTeacher Pro's validation answer; the teacher sees
    // it verbatim. Any other status is summarised.
    if (err.status === 409) return err.body || "http_409";
    return `http_${err.status}`;
  }
  return "network_error";
}

function logFailure(stage: string, assessmentId: string, err: unknown, rows: number): void {
  log.error("gradebook_push_failed", {
    target: "powerschool",
    stage,
    assessment_id: assessmentId,
    rows,
    status: err instanceof GradebookHttpError ? err.status : undefined,
    body: err instanceof GradebookHttpError && err.status === 409 ? maskIdsForLog(err.body) : undefined,
    message: err instanceof GradebookHttpError ? undefined : err instanceof Error ? err.message.slice(0, 300) : "unknown",
  });
}

async function livePush(db: Db, assessmentId: string, sectionPsId: string): Promise<GradebookPushRow | null> {
  const [row] = await db
    .select()
    .from(gradebook_pushes)
    .where(
      and(
        eq(gradebook_pushes.assessment_id, assessmentId),
        eq(gradebook_pushes.section_ps_id, sectionPsId),
        eq(gradebook_pushes.target, "powerschool"),
        isNull(gradebook_pushes.archived_at),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function priorScores(db: Db, pushId: string): Promise<Map<string, PriorScore>> {
  const rows = await db
    .select()
    .from(gradebook_push_scores)
    .where(eq(gradebook_push_scores.push_id, pushId));
  return new Map(
    rows.map((r) => [r.attempt_id, { points_sent: r.points_sent, external_score_id: r.external_score_id }]),
  );
}

/**
 * Claim the (assessment, section, target) slot BEFORE creating anything
 * externally, so two concurrent first sends cannot both create an
 * assignment: the partial unique index lets exactly one insert through. A
 * claim left by a crashed send (still no external id after CLAIM_STALE_MS)
 * is removed and claimed afresh.
 */
async function claim(
  db: Db,
  input: PowerSchoolSendInput,
  name: string,
): Promise<{ ok: true; row: GradebookPushRow } | { ok: false }> {
  await db
    .delete(gradebook_pushes)
    .where(
      and(
        eq(gradebook_pushes.assessment_id, input.assessment.id),
        eq(gradebook_pushes.section_ps_id, input.section.ps_id),
        eq(gradebook_pushes.target, "powerschool"),
        isNull(gradebook_pushes.archived_at),
        isNull(gradebook_pushes.external_assignment_id),
        lt(gradebook_pushes.created_at, new Date(Date.now() - CLAIM_STALE_MS)),
      ),
    );
  try {
    const [row] = await db
      .insert(gradebook_pushes)
      .values({
        assessment_id: input.assessment.id,
        section_ps_id: input.section.ps_id,
        target: "powerschool",
        category_id: input.category_id,
        name,
        created_by_sub: input.teacher.sub,
        actor_sub: input.actor_sub,
      })
      .returning();
    return { ok: true, row: row! };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false };
    throw err;
  }
}

export async function sendToPowerSchool(
  db: Db,
  client: PowerSchoolClient,
  input: PowerSchoolSendInput,
): Promise<SendOutcome> {
  const { assessment, section, teacher } = input;
  const missing = missingPowerSchoolIds(teacher.users_dcid, section);
  if (missing.length > 0) {
    return { ok: false, status: 409, error: "missing_dcid", detail: { missing } };
  }
  const usersDcid = teacher.users_dcid!;

  let push = await livePush(db, assessment.id, section.ps_id);
  if (push && !push.external_assignment_id) {
    // Another first send is creating the assignment right now (or crashed
    // doing so less than CLAIM_STALE_MS ago).
    if (push.created_at.getTime() > Date.now() - CLAIM_STALE_MS) {
      return { ok: false, status: 409, error: "send_in_progress" };
    }
    push = null; // stale: `claim` removes it
  }

  const prior = push ? await priorScores(db, push.id) : new Map<string, PriorScore>();
  const { candidates, max_points } = await loadSectionCandidates(db, assessment.id, section.ps_id);
  const plan = planSend(candidates, prior);

  const reasons = emptyReasons();
  for (const h of plan.held_back) reasons[h.reason]++;
  const summary: SendSummary = {
    target: "powerschool",
    external_assignment_id: push?.external_assignment_id ?? null,
    assignment_created: false,
    sent: 0,
    updated: 0,
    skipped_unchanged: plan.skipped_unchanged.length,
    held_back: { count: plan.held_back.length, reasons },
    failed: [],
    notes: [],
  };

  // 8.3: attempts sent before that are not being (re)sent now — passed back
  // and not yet handed in again, or handed in again but not yet fully scored.
  // Their earlier score stays in the gradebook until a later send.
  const current = new Set([...plan.writes.map((w) => w.attempt_id), ...plan.skipped_unchanged]);
  const kept = [...prior.keys()].filter((id) => !current.has(id));
  if (kept.length > 0) {
    const reopened = await db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(inArray(attempts.id, kept), eq(attempts.status, "in_progress")));
    const passedBack = reopened.length;
    const awaiting = kept.length - passedBack;
    if (passedBack > 0) {
      summary.notes.push(
        passedBack === 1
          ? "1 student passed back since an earlier send keeps that earlier score in the gradebook until they hand in again and you send again."
          : `${passedBack} students passed back since an earlier send keep their earlier scores in the gradebook until they hand in again and you send again.`,
      );
    }
    if (awaiting > 0) {
      summary.notes.push(
        awaiting === 1
          ? "1 student sent earlier now has work awaiting scoring; the earlier score stays in the gradebook until you score it and send again."
          : `${awaiting} students sent earlier now have work awaiting scoring; their earlier scores stay in the gradebook until you score them and send again.`,
      );
    }
  }

  // Nothing to write: never create an empty assignment.
  if (plan.writes.length === 0) {
    if (push) await recordSend(db, push.id, input, summary);
    return { ok: true, summary };
  }

  if (!push) {
    if (max_points <= 0) return { ok: false, status: 409, error: "no_points" };
    let categories;
    try {
      categories = await client.listCategories(usersDcid, section.year_id!);
    } catch (err) {
      logFailure("categories", assessment.id, err, 0);
      return { ok: false, status: 502, error: "gradebook_unavailable" };
    }
    const category = categories.find((c) => c.id === input.category_id && c.isactive);
    if (!category) return { ok: false, status: 400, error: "unknown_category" };

    const name = truncateAssignmentName(input.name);
    const claimed = await claim(db, input, name);
    if (!claimed.ok) return { ok: false, status: 409, error: "send_in_progress" };

    let created;
    try {
      created = await client.createAssignment(
        usersDcid,
        buildAssignmentCreateBody({
          sectionDcid: section.dcid!,
          name,
          dueDate: input.due_date,
          maxPoints: max_points,
          categoryId: category.id,
          publishOption: category.defaultpublishoption,
        }),
      );
    } catch (err) {
      await db.delete(gradebook_pushes).where(eq(gradebook_pushes.id, claimed.row.id));
      logFailure("create", assessment.id, err, plan.writes.length);
      return {
        ok: false,
        status: 502,
        error: "create_failed",
        detail: err instanceof GradebookHttpError && err.status === 409 ? err.body : undefined,
      };
    }
    if (!created.assignmentSectionId) {
      // Created (probably) but unreadable: keep no claim, so a retry is
      // possible, and say so loudly — a duplicate assignment may result.
      await db.delete(gradebook_pushes).where(eq(gradebook_pushes.id, claimed.row.id));
      log.error("gradebook_push_failed", {
        target: "powerschool",
        stage: "create_response",
        assessment_id: assessment.id,
      });
      return { ok: false, status: 502, error: "create_response_unreadable" };
    }
    const [updated] = await db
      .update(gradebook_pushes)
      .set({ external_assignment_id: created.assignmentSectionId })
      .where(eq(gradebook_pushes.id, claimed.row.id))
      .returning();
    push = updated!;
    summary.external_assignment_id = created.assignmentSectionId;
    summary.assignment_created = true;
  }

  await writeScores(db, client, push, input, usersDcid, plan.writes, summary);
  await recordSend(db, push.id, input, summary);
  return { ok: true, summary };
}

async function writeScores(
  db: Db,
  client: PowerSchoolClient,
  push: GradebookPushRow,
  input: PowerSchoolSendInput,
  usersDcid: string,
  writes: PlannedWrite[],
  summary: SendSummary,
): Promise<void> {
  const assignmentSectionId = push.external_assignment_id!;
  const body = buildScoreWriteBodyUnconfirmed(
    assignmentSectionId,
    writes.map((w) => ({ studentDcid: w.student_dcid, points: w.points, externalScoreId: w.external_score_id })),
  );

  let response: unknown;
  try {
    response = await client.writeScores(usersDcid, input.section.term_id!, body);
  } catch (err) {
    logFailure("scores", input.assessment.id, err, writes.length);
    let reason = failureReason(err);
    if (err instanceof GradebookHttpError && err.status === 404) {
      // The assignment is gone from PowerTeacher Pro (deleted there). Retire
      // this push so the next send creates a new one.
      await db
        .update(gradebook_pushes)
        .set({ archived_at: new Date() })
        .where(eq(gradebook_pushes.id, push.id));
      reason = "assignment_missing";
      summary.notes.push(
        "The assignment was not found in PowerSchool (deleted there?). Send again to create a new one.",
      );
    }
    summary.failed.push(...writes.map((w): SendFailure => ({ student_number: w.student_number, reason })));
    return;
  }

  const outcome = parseScoreWriteResponseUnconfirmed(response);
  const now = new Date();
  for (const w of writes) {
    const row = outcome.byStudentDcid.get(w.student_dcid);
    if (row?.error) {
      summary.failed.push({ student_number: w.student_number, reason: row.error });
      continue;
    }
    const externalScoreId = row?.assignmentscoreid ?? w.external_score_id;
    await db
      .insert(gradebook_push_scores)
      .values({
        push_id: push.id,
        attempt_id: w.attempt_id,
        external_score_id: externalScoreId,
        points_sent: w.points,
        sent_at: now,
      })
      .onConflictDoUpdate({
        target: [gradebook_push_scores.push_id, gradebook_push_scores.attempt_id],
        set: { external_score_id: externalScoreId, points_sent: w.points, sent_at: now },
      });
    await db.insert(attempt_events).values({
      attempt_id: w.attempt_id,
      kind: "gradebook_sent",
      at: now,
      detail: { target: "powerschool", external_assignment_id: assignmentSectionId, points: w.points },
    });
    if (w.kind === "update") summary.updated++;
    else summary.sent++;
  }
  if (summary.failed.length > 0) {
    log.error("gradebook_push_failed", {
      target: "powerschool",
      stage: "score_rows",
      assessment_id: input.assessment.id,
      rows: summary.failed.length,
    });
  }
}

/** The push row's last result, and the remembered destination (D-5). */
async function recordSend(
  db: Db,
  pushId: string,
  input: PowerSchoolSendInput,
  summary: SendSummary,
): Promise<void> {
  const now = new Date();
  // At least one student's score is in the gradebook as of this send.
  const reachedGradebook = summary.sent + summary.updated + summary.skipped_unchanged > 0;
  await db
    .update(gradebook_pushes)
    .set({
      last_sent_at: now,
      last_result: {
        sent: summary.sent,
        updated: summary.updated,
        skipped_unchanged: summary.skipped_unchanged,
        held_back: summary.held_back,
        failed: summary.failed,
      },
    })
    .where(eq(gradebook_pushes.id, pushId));
  // D-5: remembered only when the send reached the gradebook.
  if (!reachedGradebook) return;
  await db
    .insert(gradebook_section_prefs)
    .values({
      staff_sub: input.teacher.sub,
      section_ps_id: input.section.ps_id,
      target: "powerschool",
      category_id: input.category_id,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [gradebook_section_prefs.staff_sub, gradebook_section_prefs.section_ps_id],
      set: { target: "powerschool", category_id: input.category_id, updated_at: now },
    });
}
