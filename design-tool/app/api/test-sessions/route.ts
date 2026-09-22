import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { TEST_SESSION_KINDS, assessments, test_sessions } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  CodeExhaustionError,
  DEFAULT_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  createSessionWithCode,
  sittingVisibleToCaller,
  sweepExpired,
} from "@/lib/api/testSessions";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";
import { visibleAssessmentScope } from "@/lib/api/visibleAssessments";
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
  // Practice sittings (docs/practice-sitting-design.md, D-1/D-2): omitted =
  // `class`. A practice sitting is for the caller alone and takes no scope.
  kind: z.enum(TEST_SESSION_KINDS).optional(),
});

/**
 * The sittings the caller can see, newest first. Optionally narrowed to one
 * assessment.
 *
 * Access slice 2: the predicate is "sittings whose ASSESSMENT I can see", not
 * `test_sessions.owner_sub`. That is the same authority `authorizeSitting` uses
 * (the assessment, not the sitting's own owner), so a sitting the lead teacher
 * started appears in the co-teacher's list and opens in their monitor instead of
 * listing and then 404ing. A substitute's sitting stays the teacher's and shows
 * in both lists for the same reason.
 */
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const assessmentId = new URL(req.url).searchParams.get("assessment_id");
  if (assessmentId !== null && !UUID_RE.test(assessmentId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  // Archive (docs/archive-and-delete-design.md, D-4): archived sittings are
  // hidden by default; `?archived=1` shows ONLY them.
  const wantArchived =
    new URL(req.url).searchParams.get("archived") === "1";
  // Slice 5a: `?all=1` widens an admin's list the same way
  // `GET /api/assessments` does — ignored for a non-admin.
  const wantAll = new URL(req.url).searchParams.get("all") === "1";

  const db = getDb();
  const visible = await visibleAssessmentScope(db, auth.session, { all: wantAll });
  const scope = and(
    visible.condition,
    sittingVisibleToCaller(auth.session.sub),
    assessmentId ? eq(test_sessions.assessment_id, assessmentId) : undefined,
    wantArchived
      ? isNotNull(test_sessions.archived_at)
      : isNull(test_sessions.archived_at),
  );

  const rows = await db
    .select({ sitting: test_sessions })
    .from(test_sessions)
    .innerJoin(assessments, eq(assessments.id, test_sessions.assessment_id))
    .where(scope)
    .orderBy(desc(test_sessions.created_at));
  return NextResponse.json({ test_sessions: rows.map((r) => r.sitting) });
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
  // A sitting may only be started on an assessment the caller may run; the
  // 404-for-not-yours posture is the helper's (access slice 1, D-3).
  const access = await authorizeAssessment(db, auth.session, body.assessment_id, "run");
  if (!access.ok) return access.response;
  const assessment = access.assessment;
  // Slice 82: only a published assessment can be sat. A draft is still being
  // edited — items can change under a student mid-test — and publishing is
  // the act that freezes it (slice 41's lock). 409, not 400: the body is fine,
  // the assessment's state is not.
  if (assessment.status !== "published") {
    return NextResponse.json({ ok: false, error: "not_published" }, { status: 409 });
  }
  // Archive (docs/archive-and-delete-design.md): nothing new starts on an
  // archived assessment. Existing sittings, attempts and results are
  // untouched and still reachable from the editor.
  if (assessment.archived_at !== null) {
    return NextResponse.json({ ok: false, error: "archived" }, { status: 409 });
  }

  // Access slice 2 (D-5): whose sitting is this?
  //
  //   owner / admin / an ASSESSMENT-scoped grant (a co-teacher) → the caller's.
  //     A co-teacher runs their OWN section, so the sitting must carry their
  //     sub and email or redemption would scope the roster to the wrong
  //     teacher and admit nobody.
  //   a TEACHER-scoped grant (a substitute) → the granting teacher's. D-5: the
  //     sitting stays the teacher's after the sub leaves, so `owner_sub` /
  //     `owner_email` come from the assessment and only `created_by_sub`
  //     records the sub. That also means the sitting admits the TEACHER's
  //     students, which is the point of covering a class.
  //
  // `created_by_sub` is always the caller either way — audit, never authority.
  const coveringForTeacher = access.via === "grant" && access.scope === "teacher";
  const sittingOwnerSub = coveringForTeacher
    ? assessment.owner_sub
    : auth.session.sub;
  const sittingOwnerEmail = coveringForTeacher
    ? assessment.owner_email
    : normalizeEmail(auth.session.email);

  // Slice 79: a scope narrows "all my sections"; it never widens it. A
  // named section must be one the owner currently teaches, and every listed
  // student must be in one of those sections — so a sitting can be run for a
  // make-up group, but a teacher cannot admit a child they do not teach by
  // typing an id. Widening (coaches, admins) is open question 3.6.
  const ownerEmail = normalizeEmail(auth.session.email);
  // D-1: a practice sitting admits exactly one principal — the caller — so a
  // section or a student list on one is a contradiction, not a narrowing.
  const practice = body.kind === "practice";
  if (practice && (body.section_ps_id !== undefined || body.student_ps_ids !== undefined)) {
    return NextResponse.json({ ok: false, error: "scope_conflict" }, { status: 400 });
  }
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
  // Swept for the sitting's OWNER, which is whose code-holding rows could
  // block the new one.
  await sweepExpired(db, sittingOwnerSub);

  const minutes = body.duration_minutes ?? DEFAULT_DURATION_MINUTES;
  const expiresAt = new Date(Date.now() + minutes * 60_000);

  try {
    const row = await createSessionWithCode(db, {
      assessment_id: assessment.id,
      owner_sub: sittingOwnerSub,
      // Slice 78: the join to roster_section_teachers that scopes who may
      // join. Sessions minted before slice 77 carry no email; such a sitting
      // admits nobody until the teacher signs in again.
      owner_email: sittingOwnerEmail,
      created_by_sub: auth.session.sub,
      section_ps_id: body.section_ps_id ?? null,
      student_ps_ids: body.student_ps_ids
        ? [...new Set(body.student_ps_ids)]
        : null,
      expires_at: expiresAt,
      // D-1/D-2: `run` on the assessment (checked above) is all practice
      // needs; the owner fields follow the creator exactly as a class
      // sitting's do. `practice_for_sub` is the session's EFFECTIVE sub, so an
      // act-as practice sitting is joinable only by the teacher (noted in the
      // design, not special-cased).
      kind: practice ? "practice" : "class",
      practice_for_sub: practice ? auth.session.sub : null,
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
