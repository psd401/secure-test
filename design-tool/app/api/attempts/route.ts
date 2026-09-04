import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attempts, type AttemptRow } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import {
  resolveStudentForOwner,
  statusForResolutionFailure,
} from "@/lib/api/resolveStudent";
import { loadJoinableSitting } from "@/lib/api/studentAttempt";
import { UUID_RE } from "@/lib/uuid";

const StartBody = z.object({
  test_session_id: z.string().regex(UUID_RE, "test_session_id must be a uuid"),
});

/**
 * Slice 61: start or resume the student's attempt at the sitting's assessment.
 *
 * Keyed on the SITTING, not on an assessment id. A student who could name an
 * assessment directly would not need a code at all, and the code plus roster
 * check is the entire admission story.
 *
 * Create-or-resume rather than create: there is one attempt per (student,
 * assessment) by decision, so joining a second sitting of the same assessment
 * returns the work already in progress. Beginning a blank one instead would
 * strand the first set of answers somewhere the results page would have to
 * guess between. Since finding 8.2 the resumed attempt also FOLLOWS the
 * student to the new sitting (see `rebindIfMoved`).
 */
export async function POST(req: Request) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = StartBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const sitting = await loadJoinableSitting(db, body.test_session_id);
  if (!sitting) {
    return NextResponse.json(
      { ok: false, error: "session_unavailable" },
      { status: 404 },
    );
  }

  // Slice 78: scoped to the sitting, exactly as redemption was — a student
  // who was refused the code cannot start the attempt by naming the sitting.
  const resolved = await resolveStudentForOwner(db, sitting.owner_sub, auth.session, sitting);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: resolved.reason },
      { status: statusForResolutionFailure(resolved.reason) },
    );
  }

  const [existing] = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.assessment_id, sitting.assessment_id),
        eq(attempts.student_id, resolved.student.id),
      ),
    )
    .limit(1);
  if (existing) {
    return NextResponse.json({ attempt: await rebindIfMoved(db, existing, sitting.id), resumed: true });
  }

  try {
    const [created] = await db
      .insert(attempts)
      .values({
        assessment_id: sitting.assessment_id,
        student_id: resolved.student.id,
        test_session_id: sitting.id,
        status: "in_progress",
      })
      .returning();
    return NextResponse.json({ attempt: created, resumed: false }, { status: 201 });
  } catch (err) {
    // Two devices starting at once: the unique constraint decides, and the
    // loser reads what the winner wrote rather than reporting an error to a
    // student who did nothing wrong.
    if (isUniqueViolation(err)) {
      const [row] = await db
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.assessment_id, sitting.assessment_id),
            eq(attempts.student_id, resolved.student.id),
          ),
        )
        .limit(1);
      if (row) {
        return NextResponse.json({ attempt: await rebindIfMoved(db, row, sitting.id), resumed: true });
      }
    }
    throw err;
  }
}

/**
 * Finding 8.2 (2026-08-28): an in-progress attempt resumed through a
 * DIFFERENT sitting of the same assessment follows the student to that
 * sitting.
 *
 * Before this, an attempt kept the sitting it was started in forever, so a
 * student who rejoined after the first sitting expired and the teacher opened
 * another showed as "not joined" on the new sitting's monitor and could only
 * be peeked from the old sitting's page. The sitting is where the teacher is
 * looking; the attempt should be there too.
 *
 * Only in-progress attempts move — a submitted attempt is a record of where
 * it was submitted, and nothing later un-happens that. Admission has already
 * been decided by the caller (the same `resolveStudentForOwner` check a fresh
 * join passes), so a sitting that refuses the student never reaches here.
 * `attempts.test_session_id` is the only per-attempt sitting reference;
 * responses, events and peek requests all key on the attempt id and so are
 * carried along untouched.
 *
 * The status guard is repeated in the UPDATE so a submit racing this request
 * cannot be rebound after the fact; if that race is lost, the row read above
 * is returned as-is, which is what the pre-8.2 path did.
 */
async function rebindIfMoved(
  db: ReturnType<typeof getDb>,
  attempt: AttemptRow,
  sittingId: string,
): Promise<AttemptRow> {
  if (attempt.status !== "in_progress" || attempt.test_session_id === sittingId) {
    return attempt;
  }
  const [rebound] = await db
    .update(attempts)
    .set({ test_session_id: sittingId, updated_at: new Date() })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.status, "in_progress")))
    .returning();
  return rebound ?? attempt;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
