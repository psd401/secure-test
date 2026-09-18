import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { test_sessions, type AttemptRow } from "@/db/schema";
import type { getDb } from "@/db/client";

// The owner check that used to live here (`loadOwnedAttempt`) is now
// `authorizeAttempt` in lib/api/access.ts — one ownership path for every row
// (docs/access-model-design.md, D-3). What is left is the open-sitting guard,
// which is about the STATE of the attempt, not about who may touch it.

type Db = ReturnType<typeof getDb>;

/**
 * Is this attempt still live in an open sitting — i.e. might the student be
 * locked in and mid-answer right now?
 *
 * The one rule behind both destructive teacher actions: deleting the attempt
 * would 404 the student's next save under them, and handing it in would turn
 * a half-written answer into a final one.
 *
 * Note what is NOT part of it: the sitting's `expires_at`. `attemptAcceptsWrites`
 * (lib/api/studentAttempt.ts) deliberately keeps taking answers after a sitting
 * expires — "a sitting that expires while a child is mid-sentence should not
 * discard the sentence" — so a student can still be writing in an open sitting
 * that is past its expiry, and the guard has to hold there too. A submitted
 * attempt is never blocked: there is no answer in flight to protect.
 */
export async function sittingIsOpen(db: Db, attempt: AttemptRow): Promise<boolean> {
  if (attempt.status === "submitted") return false;
  if (!attempt.test_session_id) return false;
  const [sitting] = await db
    .select({ status: test_sessions.status })
    .from(test_sessions)
    .where(eq(test_sessions.id, attempt.test_session_id))
    .limit(1);
  return sitting?.status === "open";
}

export function sessionOpenResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "session_open" }, { status: 409 });
}
