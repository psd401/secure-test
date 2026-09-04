import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  CodeExhaustionError,
  DEFAULT_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  createSessionWithCode,
  sweepExpired,
} from "@/lib/api/testSessions";
import { UUID_RE } from "@/lib/uuid";
import {
  normalizeEmail,
  sectionsCurrentlyTaughtBy,
  studentsInTeachersSections,
} from "@/lib/roster/queries";

const PsId = z.string().min(1).max(64);

const CreateBody = z.object({
  assessment_id: z.string().regex(UUID_RE, "assessment_id must be a uuid"),
  duration_minutes: z
    .number()
    .int()
    .positive()
    .max(MAX_DURATION_MINUTES)
    .optional(),
  // Slice 79: scope. Omit both for "all my sections"; name one section; or
  // list specific students. Not both.
  section_ps_id: PsId.optional(),
  student_ps_ids: z.array(PsId).min(1).max(500).optional(),
});

/** A teacher's own sittings, newest first. Optionally narrowed to one assessment. */
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const assessmentId = new URL(req.url).searchParams.get("assessment_id");
  if (assessmentId !== null && !UUID_RE.test(assessmentId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const scope = assessmentId
    ? and(
        eq(test_sessions.owner_sub, auth.session.sub),
        eq(test_sessions.assessment_id, assessmentId),
      )
    : eq(test_sessions.owner_sub, auth.session.sub);

  const rows = await db
    .select()
    .from(test_sessions)
    .where(scope)
    .orderBy(desc(test_sessions.created_at));
  return NextResponse.json({ test_sessions: rows });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = CreateBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  // Ownership, not existence: a teacher may only run a sitting of their own
  // assessment. Same 404-for-not-yours posture the rest of the API uses, so an
  // id probe cannot distinguish "does not exist" from "not yours".
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(
      and(
        eq(assessments.id, body.assessment_id),
        eq(assessments.owner_sub, auth.session.sub),
      ),
    )
    .limit(1);
  if (!assessment) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  // Slice 82: only a published assessment can be sat. A draft is still being
  // edited — items can change under a student mid-test — and publishing is
  // the act that freezes it (slice 41's lock). 409, not 400: the body is fine,
  // the assessment's state is not.
  if (assessment.status !== "published") {
    return NextResponse.json({ ok: false, error: "not_published" }, { status: 409 });
  }

  // Slice 79: a scope narrows "all my sections"; it never widens it. A
  // named section must be one the owner currently teaches, and every listed
  // student must be in one of those sections — so a sitting can be run for a
  // make-up group, but a teacher cannot admit a child they do not teach by
  // typing an id. Widening (coaches, admins) is open question 3.6.
  const ownerEmail = normalizeEmail(auth.session.email);
  if (body.section_ps_id !== undefined && body.student_ps_ids !== undefined) {
    return NextResponse.json({ ok: false, error: "scope_conflict" }, { status: 400 });
  }
  if (body.section_ps_id !== undefined) {
    const mine = ownerEmail ? await sectionsCurrentlyTaughtBy(db, ownerEmail) : [];
    if (!mine.some((s) => s.ps_id === body.section_ps_id)) {
      return NextResponse.json({ ok: false, error: "section_not_taught" }, { status: 400 });
    }
  }
  if (body.student_ps_ids !== undefined) {
    const mine = new Set(
      ownerEmail
        ? (await studentsInTeachersSections(db, ownerEmail)).map((r) => r.student.ps_id)
        : [],
    );
    if (!body.student_ps_ids.every((id) => mine.has(id))) {
      return NextResponse.json({ ok: false, error: "students_not_taught" }, { status: 400 });
    }
  }

  // Release codes held by this teacher's expired-but-unclosed sittings before
  // allocating a new one. See sweepExpired for why this cannot be an index
  // predicate.
  await sweepExpired(db, auth.session.sub);

  const minutes = body.duration_minutes ?? DEFAULT_DURATION_MINUTES;
  const expiresAt = new Date(Date.now() + minutes * 60_000);

  try {
    const row = await createSessionWithCode(db, {
      assessment_id: assessment.id,
      owner_sub: auth.session.sub,
      // Slice 78: the join to roster_section_teachers that scopes who may
      // join. Sessions minted before slice 77 carry no email; such a sitting
      // admits nobody until the teacher signs in again.
      owner_email: ownerEmail,
      section_ps_id: body.section_ps_id ?? null,
      student_ps_ids: body.student_ps_ids
        ? [...new Set(body.student_ps_ids)]
        : null,
      expires_at: expiresAt,
    });
    return NextResponse.json({ test_session: row }, { status: 201 });
  } catch (err) {
    if (err instanceof CodeExhaustionError) {
      console.error("test-sessions: code space exhausted for", auth.session.sub);
      return NextResponse.json(
        { ok: false, error: "code_unavailable" },
        { status: 503 },
      );
    }
    throw err;
  }
}
