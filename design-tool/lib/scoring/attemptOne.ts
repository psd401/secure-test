/**
 * "Attempt 1" of a passed-back test (docs/bulk-pass-back-and-corrections-design.md,
 * slice 2, D-15…D-20): the score the student had before their test was passed
 * back for another try, rebuilt from what is already stored — no column holds
 * it, so pass backs made before this slice shipped are covered too.
 *
 * Which hand-in is attempt 1 (D-15, 4.3, 5.5): the FIRST pass back that
 * reverses a hand-in the STUDENT made themselves. A pass back that reverses a
 * teacher's hand-in (Hand in, Hand in everyone, Hand in all in progress — all
 * write a `teacher_hand_in` event through `handInAttempt`) was an extension,
 * not an attempt: a student cannot hand in after their deadline (the submit
 * route's `refuseIfPastDeadline`), so time running out always ends in one of
 * those. The rounds are cut at each `passed_back` event; a round with a
 * `teacher_hand_in` in it is skipped.
 *
 * Its score: for every answer that existed at that pass back, the LAST score
 * given in that round — `final`, or `superseded` (by the pass back itself or
 * by a later Change) — never `proposed` or `research`. Earlier rounds' scores
 * were all superseded at their own pass back and are not this attempt's.
 * An answer with no such score makes attempt 1 `not_fully_scored` (5.1): it is
 * shown, but no total is offered and an attempt-1 gradebook send leaves the
 * student out, the rule every send already follows.
 */

import { and, asc, inArray, ne } from "drizzle-orm";
import { attempt_events, responses, scores } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

export type AttemptOne =
  | { kind: "scored"; total: number; passed_back_at: string }
  | { kind: "not_fully_scored"; passed_back_at: string };

export interface AttemptOneEvent {
  kind: string;
  at: Date;
}
export interface AttemptOneResponse {
  id: string;
  created_at: Date;
}
export interface AttemptOneScore {
  response_id: string;
  status: string;
  points: number;
  created_at: Date;
}

/**
 * The rule, on one attempt's rows. Pure so every case is a unit test; null
 * when the attempt has no attempt 1 (never passed back, or only ever passed
 * back as an extension) — then its latest score is its only one.
 */
export function attemptOneFrom(
  events: readonly AttemptOneEvent[],
  responseRows: readonly AttemptOneResponse[],
  scoreRows: readonly AttemptOneScore[],
): AttemptOne | null {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  let roundStart = -Infinity;
  let teacherHandedIn = false;
  let passBackAt: Date | null = null;
  for (const e of sorted) {
    if (e.kind === "teacher_hand_in") teacherHandedIn = true;
    if (e.kind !== "passed_back") continue;
    if (!teacherHandedIn) {
      passBackAt = e.at;
      break;
    }
    roundStart = e.at.getTime();
    teacherHandedIn = false;
  }
  if (!passBackAt) return null;

  const end = passBackAt.getTime();
  const inRound = (d: Date) => d.getTime() > roundStart && d.getTime() <= end;
  let total = 0;
  for (const r of responseRows) {
    if (r.created_at.getTime() > end) continue;
    const last = scoreRows
      .filter(
        (s) =>
          s.response_id === r.id &&
          (s.status === "final" || s.status === "superseded") &&
          inRound(s.created_at),
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    if (!last) return { kind: "not_fully_scored", passed_back_at: passBackAt.toISOString() };
    total += last.points;
  }
  return { kind: "scored", total, passed_back_at: passBackAt.toISOString() };
}

/** `attemptOneFrom` for many attempts in three queries; an attempt with no
 * attempt 1 has no entry. Callers pass only attempts with
 * `pass_back_count > 0` — the rest cannot have one. */
export async function attemptOneByAttempt(
  db: Db,
  attemptIds: readonly string[],
): Promise<Map<string, AttemptOne>> {
  const out = new Map<string, AttemptOne>();
  if (attemptIds.length === 0) return out;
  const ids = [...attemptIds];

  const eventRows = await db
    .select({ attempt_id: attempt_events.attempt_id, kind: attempt_events.kind, at: attempt_events.at })
    .from(attempt_events)
    .where(
      and(
        inArray(attempt_events.attempt_id, ids),
        inArray(attempt_events.kind, ["teacher_hand_in", "passed_back"]),
      ),
    )
    .orderBy(asc(attempt_events.at));
  const responseRows = await db
    .select({ id: responses.id, attempt_id: responses.attempt_id, created_at: responses.created_at })
    .from(responses)
    .where(inArray(responses.attempt_id, ids));
  const scoreRows =
    responseRows.length > 0
      ? await db
          .select({
            response_id: scores.response_id,
            status: scores.status,
            points: scores.points,
            created_at: scores.created_at,
          })
          .from(scores)
          .where(
            and(
              inArray(
                scores.response_id,
                responseRows.map((r) => r.id),
              ),
              ne(scores.status, "research"),
            ),
          )
      : [];

  const attemptByResponse = new Map(responseRows.map((r) => [r.id, r.attempt_id]));
  for (const id of ids) {
    const one = attemptOneFrom(
      eventRows.filter((e) => e.attempt_id === id),
      responseRows.filter((r) => r.attempt_id === id),
      scoreRows.filter((s) => attemptByResponse.get(s.response_id) === id),
    );
    if (one) out.set(id, one);
  }
  return out;
}
