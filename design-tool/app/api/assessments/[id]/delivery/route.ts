import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempts } from "@/db/schema";
import { requireStudentOrPractice } from "@/lib/api/requireSession";
import {
  resolveStudentForOwner,
  statusForResolutionFailure,
} from "@/lib/api/resolveStudent";
import {
  resolveEffectiveAccommodations,
} from "@/lib/accommodations/effective";
import { coTeacherRecordStudentIds } from "@/lib/accommodations/coTeacherRecords";
import {
  UnknownItemTypeError,
  buildDeliveryBundle,
} from "@/lib/api/buildDeliveryBundle";
import { IncompleteItemError } from "@/lib/api/itemIntegrity";
import { deadlineFor, refuseIfPastDeadline } from "@/lib/api/attemptDeadline";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The student delivery bundle: the same items as /export with every answer key
 * removed, plus the accommodations THIS student gets on THIS assessment.
 *
 * Slice 62 closes the debt slice 51 opened. That slice shipped this route
 * unauthenticated behind ALLOW_UNAUTHENTICATED_DELIVERY, hard-failing in
 * production, because no student principal existed yet to authorise against.
 * The flag is gone; the route now requires one.
 *
 * Authorisation is an existing ATTEMPT, not merely roster membership. The
 * client's flow is redeem-code → start-attempt → fetch-bundle, so an attempt
 * always exists by the time the bundle is wanted, and requiring it means the
 * code and roster checks that gated attempt creation also gate the content. A
 * student on a teacher's roster still cannot read an assessment they were never
 * admitted to.
 */
/** Sent by client v1.5.0+ on every API call (`APIClient.versionHeader`). */
const CLIENT_VERSION_HEADER = "x-securetest-version";

export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStudentOrPractice();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessment) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const resolved = await resolveStudentForOwner(db, assessment.owner_sub, auth.session);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: resolved.reason },
      { status: statusForResolutionFailure(resolved.reason) },
    );
  }

  const [attempt] = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.assessment_id, assessment.id),
        eq(attempts.student_id, resolved.student.id),
      ),
    )
    .limit(1);
  if (!attempt) {
    // 404 rather than 403: an assessment this student was never admitted to
    // should be indistinguishable from one that does not exist.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // EX-2: an in-progress attempt whose time is up (deadline + the shared
  // grace) gets the same 409 the write routes give, rather than a bundle
  // counting down to an instant already past. Submitted attempts are left as
  // they were; no limit / removed limit / extension all resolve inside
  // deadlineFor, so there is one rule.
  //
  // Only for a client that sends `X-SecureTest-Version` (v1.5.0+, which
  // handles the 409 by going home with "Your time for this test has run
  // out"). A client without it (≤ v1.4.0) dead-ends on a 409 — "This test
  // could not be opened" and no way home but Cmd-Q — so it keeps the old
  // 200 and its own countdown ends the session.
  if (attempt.status === "in_progress" && req.headers.has(CLIENT_VERSION_HEADER)) {
    const expired = await refuseIfPastDeadline(db, attempt);
    if (expired) return expired;
  }

  const accommodations = await resolveEffectiveAccommodations(
    db,
    assessment,
    resolved.student.id,
    // U-17: co-teachers who currently teach this child add their records
    // (the owner's are read first and win a same-tool conflict).
    await coTeacherRecordStudentIds(db, assessment, resolved.student.roster_ps_id),
  );

  try {
    const { bundle, bundledCount } = await buildDeliveryBundle(
      db,
      assessment,
      accommodations,
      attempt.id,
      resolved.student.id,
      // Time limit (D-2): `started_at + time_limit_seconds`, per attempt, so
      // a relaunch or a resume in a later sitting counts down to the same
      // instant. Null — and no new bundle keys — when there is no limit.
      deadlineFor(attempt, assessment),
    );
    return NextResponse.json(bundle, {
      status: 200,
      headers: { "x-bundled-asset-count": String(bundledCount) },
    });
  } catch (err) {
    if (err instanceof UnknownItemTypeError) {
      console.error(`delivery: ${err.message} (assessment ${assessment.id})`);
      return NextResponse.json(
        { ok: false, error: "unknown_item_type", item_id: err.itemId },
        { status: 500 },
      );
    }
    if (err instanceof IncompleteItemError) {
      // Logged with the id because the student cannot report which item broke —
      // they never saw it. The teacher needs the log to find it.
      console.error(`delivery: ${err.message} (assessment ${assessment.id})`);
      return NextResponse.json(
        { ok: false, error: "incomplete_item", item_id: err.itemId },
        { status: 409 },
      );
    }
    throw err;
  }
}
