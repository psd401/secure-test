import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { test_sessions } from "@/db/schema";
import { requireStudent } from "@/lib/api/requireSession";
import {
  isWellFormedCode,
  normalizeCode,
} from "@/lib/api/testSessions";
import {
  resolveStudentForOwner,
  statusForResolutionFailure,
} from "@/lib/api/resolveStudent";

const RedeemBody = z.object({ code: z.string().min(1).max(32) });

/**
 * Slice 60: a student joins a sitting by code.
 *
 * Two gates, and the order matters. The code must name an open, unexpired
 * sitting, AND the student must be on the roster of the teacher who created it.
 * A code alone is not an authorisation: codes are read aloud in classrooms and
 * travel further than the room, so the roster check is what actually decides
 * whether this child is meant to be in this sitting.
 *
 * Returns the identifiers the client needs to fetch the bundle and start an
 * attempt. Creating the attempt itself is slice 61.
 */
export async function POST(req: Request) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = RedeemBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  // Rejected before touching the database — a malformed code cannot match
  // anything, and answering shape errors and lookup misses identically would
  // make a mistyped code indistinguishable from an expired one for the student.
  if (!isWellFormedCode(body.code)) {
    return NextResponse.json({ ok: false, error: "malformed_code" }, { status: 400 });
  }
  const code = normalizeCode(body.code);

  const db = getDb();
  const [session] = await db
    .select()
    .from(test_sessions)
    .where(
      and(
        eq(test_sessions.code, code),
        eq(test_sessions.status, "open"),
        // Expiry is enforced HERE rather than trusted to the status column:
        // nothing flips status the moment a sitting expires, so a sitting can
        // be open and expired at once. The partial unique index guarantees at
        // most one open row per code, so this narrows rather than disambiguates.
        gt(test_sessions.expires_at, new Date()),
      ),
    )
    .limit(1);

  if (!session) {
    // One answer for "no such code", "already closed" and "expired". A student
    // who mistypes learns to check the code; distinguishing the cases would let
    // anyone map which codes exist.
    return NextResponse.json({ ok: false, error: "session_unavailable" }, { status: 404 });
  }

  // Slice 78: the sitting's scope (owner's sections, one section, or an
  // explicit list) is part of the resolution.
  const resolved = await resolveStudentForOwner(db, session.owner_sub, auth.session, session);
  if (!resolved.ok) {
    // A roster miss — or, since slice 78, an on-roster student outside this
    // sitting's scope — is answered as `session_unavailable`, identically to
    // an unknown or closed code.
    //
    // Reporting it honestly turned this route into an oracle: `not_on_roster`
    // means "that code is live but not yours" while `session_unavailable` means
    // "no such code", so any authenticated student could separate live codes
    // from dead ones by trying them. They still could not JOIN — the roster
    // check refuses them either way — but they could map which sittings are
    // running, in other classrooms and other schools.
    //
    // The real reason is logged rather than discarded: a teacher fielding "it
    // says the code is not open" needs to know whether the child is missing
    // from the roster, and the server log is where that belongs.
    //
    // The account-level failures are NOT collapsed. `no_email` and
    // `identity_conflict` are facts about the caller's own account, disclose
    // nothing about anyone else's sitting, and are the two a student can
    // actually get help with.
    if (resolved.reason === "not_on_roster" || resolved.reason === "not_in_sitting") {
      // The subject is Google's opaque id, not the address.
      console.warn(
        `redeem: ${resolved.reason} for sub ${auth.session.sub} ` +
          `on sitting ${session.id} (owner ${session.owner_sub})`,
      );
      return NextResponse.json(
        { ok: false, error: "session_unavailable" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: false, error: resolved.reason },
      { status: statusForResolutionFailure(resolved.reason) },
    );
  }

  return NextResponse.json({
    test_session_id: session.id,
    assessment_id: session.assessment_id,
    student_id: resolved.student.id,
    expires_at: session.expires_at,
  });
}
