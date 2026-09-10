// Slice 60: teacher-created sittings and the codes students join them with.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, students, test_sessions } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  BIOLOGY_STUDENT,
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  OTHER_TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  studentPrincipal,
} from "./helpers/roster";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateCode,
  isWellFormedCode,
  normalizeCode,
  sweepExpired,
} from "../lib/api/testSessions";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`test-sessions tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "sessions-teacher";
const OTHER_TEACHER = "sessions-other-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function seedAssessment(owner = TEACHER) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: owner, name: "Sitting", status: "published" })
    .returning();
  if (!row) throw new Error("seed failed");
  return row;
}

async function post(body: unknown) {
  const { POST } = await import("../app/api/test-sessions/route");
  return POST(
    new Request("http://localhost/api/test-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function list(query = "") {
  const { GET } = await import("../app/api/test-sessions/route");
  return GET(new Request(`http://localhost/api/test-sessions${query}`));
}

async function close(sessionId: string) {
  const { POST } = await import("../app/api/test-sessions/[sessionId]/close/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ sessionId }),
  });
}

async function archive(sessionId: string, archived: boolean) {
  const { PATCH } = await import("../app/api/test-sessions/[sessionId]/route");
  return PATCH(
    new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    }),
    { params: Promise.resolve({ sessionId }) },
  );
}

async function redeem(code: string) {
  const { POST } = await import("../app/api/test-sessions/redeem/route");
  return POST(
    new Request("http://localhost/api/test-sessions/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
}

describe("session codes", () => {
  test("are six characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code.length).toBe(CODE_LENGTH);
      expect([...code].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
    }
  });

  // Read aloud in a classroom and typed by children, so every look-alike pair
  // is excluded rather than left to context.
  test("exclude the characters people confuse on a projector", () => {
    for (const ch of ["0", "O", "1", "I", "L"]) {
      expect(CODE_ALPHABET.includes(ch)).toBe(false);
    }
    expect(CODE_ALPHABET).toBe(CODE_ALPHABET.toUpperCase());
  });

  test("normalise the separators people type unprompted", () => {
    expect(normalizeCode(" abc-123 ")).toBe("ABC123");
    expect(normalizeCode("ab c 12 3")).toBe("ABC123");
  });

  test("reject the wrong length or an excluded character", () => {
    expect(isWellFormedCode("ABC23")).toBe(false);
    expect(isWellFormedCode("ABC2345")).toBe(false);
    expect(isWellFormedCode("ABC01D")).toBe(false); // 0 and 1 are not in the alphabet
    expect(isWellFormedCode("ABC234")).toBe(true);
    expect(isWellFormedCode("abc234")).toBe(true);
    // Normalisation runs first, so separators and case are fine.
    expect(isWellFormedCode("abc-234")).toBe(true);
    expect(isWellFormedCode(" ab c234 ")).toBe(true);
  });
});

describe("POST /api/test-sessions", () => {
  test("a teacher opens a sitting of their own assessment", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const res = await post({ assessment_id: assessment.id });
    expect(res.status).toBe(201);
    const { test_session } = await res.json();
    expect(isWellFormedCode(test_session.code)).toBe(true);
    expect(test_session.status).toBe("open");
    expect(new Date(test_session.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("honours a requested duration and rejects an absurd one", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();

    const short = await post({ assessment_id: assessment.id, duration_minutes: 30 });
    const { test_session } = await short.json();
    const minutes = (new Date(test_session.expires_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThan(35);

    const absurd = await post({ assessment_id: assessment.id, duration_minutes: 100_000 });
    expect(absurd.status).toBe(400);
  });

  // 404 rather than 403, matching the rest of the API: an id probe must not
  // distinguish "does not exist" from "not yours".
  test("refuses to open a sitting of somebody else's assessment", async () => {
    const theirs = await seedAssessment(OTHER_TEACHER);
    principal = { sub: TEACHER, role: "staff" };
    const res = await post({ assessment_id: theirs.id });
    expect(res.status).toBe(404);
  });

  test("rejects a malformed body", async () => {
    principal = { sub: TEACHER, role: "staff" };
    expect((await post({})).status).toBe(400);
    expect((await post({ assessment_id: "not-a-uuid" })).status).toBe(400);
  });
});

describe("GET /api/test-sessions", () => {
  test("lists only the caller's sittings, and can narrow to one assessment", async () => {
    const mine = await seedAssessment();
    const alsoMine = await seedAssessment();
    const theirs = await seedAssessment(OTHER_TEACHER);

    principal = { sub: TEACHER, role: "staff" };
    await post({ assessment_id: mine.id });
    await post({ assessment_id: alsoMine.id });
    principal = { sub: OTHER_TEACHER, role: "staff" };
    await post({ assessment_id: theirs.id });

    principal = { sub: TEACHER, role: "staff" };
    const all = await (await list()).json();
    expect(all.test_sessions.length).toBe(2);

    const narrowed = await (await list(`?assessment_id=${mine.id}`)).json();
    expect(narrowed.test_sessions.length).toBe(1);
    expect(narrowed.test_sessions[0].assessment_id).toBe(mine.id);
  });
});

describe("POST /api/test-sessions/:id/close", () => {
  test("closes a sitting, and closing twice is not an error", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const { test_session } = await (await post({ assessment_id: assessment.id })).json();

    const first = await close(test_session.id);
    expect(first.status).toBe(200);
    expect((await first.json()).test_session.status).toBe("closed");

    // Idempotent: a teacher pressing the button twice should not see an error
    // for reaching the state they wanted.
    const second = await close(test_session.id);
    expect(second.status).toBe(200);
    expect((await second.json()).test_session.status).toBe("closed");
  });

  test("cannot close another teacher's sitting", async () => {
    principal = { sub: OTHER_TEACHER, role: "staff" };
    const theirs = await seedAssessment(OTHER_TEACHER);
    const { test_session } = await (await post({ assessment_id: theirs.id })).json();

    principal = { sub: TEACHER, role: "staff" };
    expect((await close(test_session.id)).status).toBe(404);
  });
});

// Archive (docs/archive-and-delete-design.md, D-2): the sitting leaves the
// list without leaving the database.
describe("PATCH /api/test-sessions/:id — archive", () => {
  test("a closed sitting archives, and archiving twice keeps the date", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const { test_session } = await (await post({ assessment_id: assessment.id })).json();
    await close(test_session.id);

    const res = await archive(test_session.id, true);
    expect(res.status).toBe(200);
    const first = await res.json();
    expect(first.test_session.archived_at).not.toBeNull();
    expect(first.test_session.status).toBe("closed");

    const again = await archive(test_session.id, true);
    expect(again.status).toBe(200);
    expect((await again.json()).test_session.archived_at).toBe(
      first.test_session.archived_at,
    );
  });

  test("an open, unexpired sitting is refused with 409 session_open", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const { test_session } = await (await post({ assessment_id: assessment.id })).json();

    const res = await archive(test_session.id, true);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "session_open" });
  });

  // Expired-but-unclosed counts as closed here, as everywhere else.
  test("an expired open sitting archives", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const [stale] = await getDb()
      .insert(test_sessions)
      .values({
        assessment_id: assessment.id,
        owner_sub: TEACHER,
        code: "EXPARC",
        status: "open",
        expires_at: new Date(Date.now() - 60_000),
      })
      .returning();
    expect((await archive(stale!.id, true)).status).toBe(200);
  });

  test("unarchiving clears the timestamp", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const { test_session } = await (await post({ assessment_id: assessment.id })).json();
    await close(test_session.id);
    await archive(test_session.id, true);

    const res = await archive(test_session.id, false);
    expect(res.status).toBe(200);
    expect((await res.json()).test_session.archived_at).toBeNull();
  });

  test("cannot archive another teacher's sitting", async () => {
    principal = { sub: OTHER_TEACHER, role: "staff" };
    const theirs = await seedAssessment(OTHER_TEACHER);
    const { test_session } = await (await post({ assessment_id: theirs.id })).json();
    await close(test_session.id);

    principal = { sub: TEACHER, role: "staff" };
    expect((await archive(test_session.id, true)).status).toBe(404);
  });

  test("the list hides archived sittings by default and ?archived=1 returns only them", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const live = await (await post({ assessment_id: assessment.id })).json();
    const gone = await (await post({ assessment_id: assessment.id })).json();
    await close(gone.test_session.id);
    await archive(gone.test_session.id, true);

    const shown = await (await list()).json();
    expect(shown.test_sessions.map((s: { id: string }) => s.id)).toEqual([
      live.test_session.id,
    ]);

    const hidden = await (await list("?archived=1")).json();
    expect(hidden.test_sessions.map((s: { id: string }) => s.id)).toEqual([
      gone.test_session.id,
    ]);
  });

  test("a sitting cannot be opened on an archived assessment", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    await getDb()
      .update(assessments)
      .set({ archived_at: new Date() })
      .where(eq(assessments.id, assessment.id));

    const res = await post({ assessment_id: assessment.id });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("archived");
  });
});

describe("code lifecycle", () => {
  test("two open sittings cannot share a code, but a closed one releases it", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment();
    const { test_session } = await (await post({ assessment_id: assessment.id })).json();

    await expect(
      (async () => {
        await getDb().insert(test_sessions).values({
          assessment_id: assessment.id,
          owner_sub: TEACHER,
          code: test_session.code,
          status: "open",
          expires_at: new Date(Date.now() + 60_000),
        });
      })(),
    ).rejects.toThrow();

    await close(test_session.id);
    // Now the same code is free — the unique index is partial on status.
    const [reused] = await getDb()
      .insert(test_sessions)
      .values({
        assessment_id: assessment.id,
        owner_sub: TEACHER,
        code: test_session.code,
        status: "open",
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning();
    expect(reused?.code).toBe(test_session.code);
  });

  test("sweepExpired closes past-expiry sittings and leaves live ones alone", async () => {
    const assessment = await seedAssessment();
    const db = getDb();
    const [stale] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment.id,
        owner_sub: TEACHER,
        code: "STALEX",
        status: "open",
        expires_at: new Date(Date.now() - 60_000),
      })
      .returning();
    const [live] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment.id,
        owner_sub: TEACHER,
        code: "LIVEXX",
        status: "open",
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning();

    expect(await sweepExpired(db, TEACHER)).toBe(1);
    const rows = await db.select().from(test_sessions);
    expect(rows.find((r) => r.id === stale!.id)?.status).toBe("closed");
    expect(rows.find((r) => r.id === live!.id)?.status).toBe("open");
  });

  test("sweepExpired never touches another teacher's sittings", async () => {
    const theirs = await seedAssessment(OTHER_TEACHER);
    const db = getDb();
    const [row] = await db
      .insert(test_sessions)
      .values({
        assessment_id: theirs.id,
        owner_sub: OTHER_TEACHER,
        code: "OTHERX",
        status: "open",
        expires_at: new Date(Date.now() - 60_000),
      })
      .returning();
    expect(await sweepExpired(db, TEACHER)).toBe(0);
    const [after] = await db.select().from(test_sessions).where(eq(test_sessions.id, row!.id));
    expect(after?.status).toBe("open");
  });
});

describe("POST /api/test-sessions/redeem", () => {
  // Slice 78: the sitting's owner email is what scopes admission. TEACHER
  // signs in as teacher.one (teaches Ada's sections); OTHER_TEACHER as
  // teacher.two (teaches none of them).
  async function openSitting(owner = TEACHER) {
    principal = {
      sub: owner,
      role: "staff",
      email: owner === OTHER_TEACHER ? OTHER_TEACHER_EMAIL : TEACHER_EMAIL,
    };
    const assessment = await seedAssessment(owner);
    const { test_session } = await (await post({ assessment_id: assessment.id })).json();
    return { assessment, test_session };
  }

  /** A pre-existing accommodations row for Ada under this teacher — the
   * TIDE-imported case, already bound to her roster identity. */
  async function rosterStudent(owner = TEACHER) {
    const [row] = await getDb()
      .insert(students)
      .values({
        owner_sub: owner,
        ssid: STUDENT.ssid,
        roster_ps_id: STUDENT.ps_id,
        name: STUDENT.name,
      })
      .returning();
    return row!;
  }

  test("the sitting records its owner's email for the roster join", async () => {
    const { test_session } = await openSitting();
    expect(test_session.owner_email).toBe(TEACHER_EMAIL);
    expect(test_session.section_ps_id).toBeNull();
    expect(test_session.student_ps_ids).toBeNull();
  });

  test("a rostered student joins and gets what the client needs", async () => {
    const { assessment, test_session } = await openSitting();
    const student = await rosterStudent();

    principal = studentPrincipal();
    const res = await redeem(test_session.code);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.test_session_id).toBe(test_session.id);
    expect(body.assessment_id).toBe(assessment.id);
    expect(body.student_id).toBe(student.id);
  });

  test("a student the teacher never imported is admitted from the roster and gets an overlay row", async () => {
    const { test_session } = await openSitting();
    principal = studentPrincipal();
    const res = await redeem(test_session.code);
    expect(res.status).toBe(200);
    const rows = await getDb().select().from(students);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      owner_sub: TEACHER,
      ssid: STUDENT.ssid,
      roster_ps_id: STUDENT.ps_id,
      name: STUDENT.name,
    });
    expect((await res.json()).student_id).toBe(rows[0]!.id);
  });

  test("accepts a code typed with the wrong case and stray separators", async () => {
    const { test_session } = await openSitting();
    await rosterStudent();
    principal = studentPrincipal();

    const messy = `${test_session.code.toLowerCase().slice(0, 3)}-${test_session.code.toLowerCase().slice(3)}`;
    expect((await redeem(messy)).status).toBe(200);
  });

  // A code is not an authorisation. Codes are read aloud and travel further
  // than the room, so roster membership is what actually decides.
  //
  // The refusal is deliberately INDISTINGUISHABLE from an unknown code
  // (security review, vuln 2). Answering `not_on_roster` here told any
  // authenticated student "that code is live but not yours", which separated
  // live codes from dead ones and let them map which sittings were running.
  test("a code alone does not admit a student the owner does not teach", async () => {
    // teacher.two's sitting; Ada is in none of teacher.two's sections.
    const { test_session } = await openSitting(OTHER_TEACHER);

    principal = studentPrincipal();
    const res = await redeem(test_session.code);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session_unavailable");
    expect((await getDb().select().from(students)).length).toBe(0);
  });

  test("a code alone does not admit a student who is not on the roster at all", async () => {
    const { test_session } = await openSitting();
    principal = studentPrincipal("nobody@edtools.psd401.net");
    const res = await redeem(test_session.code);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session_unavailable");
  });

  test("a live code and a dead one are indistinguishable to an outsider", async () => {
    const { test_session } = await openSitting(OTHER_TEACHER);
    principal = studentPrincipal();

    const live = await redeem(test_session.code);
    const dead = await redeem("ZZZZZZ");
    expect(live.status).toBe(dead.status);
    expect(await live.json()).toEqual(await dead.json());
  });

  // Facts about the caller's own account disclose nothing about anyone else's
  // sitting, and are the failures a student can actually get help with.
  test("account-level failures stay distinct", async () => {
    const { test_session } = await openSitting();
    await rosterStudent();
    principal = { sub: "g-sub", role: "student" };
    const res = await redeem(test_session.code);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("no_email");
  });

  test("a closed sitting cannot be joined", async () => {
    const { test_session } = await openSitting();
    await rosterStudent();
    await close(test_session.id);

    principal = studentPrincipal();
    const res = await redeem(test_session.code);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session_unavailable");
  });

  // Expiry is enforced at redemption, not trusted to the status column —
  // nothing flips status the moment a sitting expires.
  test("an expired-but-still-open sitting cannot be joined", async () => {
    const assessment = await seedAssessment();
    await rosterStudent();
    await getDb().insert(test_sessions).values({
      assessment_id: assessment.id,
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      code: "EXPYRD",
      status: "open",
      expires_at: new Date(Date.now() - 1000),
    });

    principal = studentPrincipal();
    const res = await redeem("EXPYRD");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session_unavailable");
  });

  test("an unknown code is refused the same way an expired one is", async () => {
    await rosterStudent();
    principal = studentPrincipal();
    const res = await redeem("ZZZZZZ");
    expect(res.status).toBe(404);
    // Same error as closed/expired: distinguishing them would let anyone map
    // which codes exist.
    expect((await res.json()).error).toBe("session_unavailable");
  });

  test("a malformed code is a 400, distinguishable from a wrong one", async () => {
    principal = studentPrincipal();
    const res = await redeem("nope");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("malformed_code");
  });

  test("a student session with no email cannot join", async () => {
    const { test_session } = await openSitting();
    await rosterStudent();
    principal = { sub: "g-sub", role: "student" };
    const res = await redeem(test_session.code);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("no_email");
  });
});

// Slice 79: a sitting's scope on the create API, and its effect at the code.
describe("POST /api/test-sessions — scope (slice 79)", () => {
  async function open(body: Record<string, unknown>, owner = TEACHER) {
    principal = {
      sub: owner,
      role: "staff",
      email: owner === OTHER_TEACHER ? OTHER_TEACHER_EMAIL : TEACHER_EMAIL,
    };
    const assessment = await seedAssessment(owner);
    return post({ assessment_id: assessment.id, ...body });
  }

  test("one of my sections is accepted and recorded", async () => {
    const res = await open({ section_ps_id: "5003" });
    expect(res.status).toBe(201);
    const { test_session } = await res.json();
    expect(test_session.section_ps_id).toBe("5003");
    expect(test_session.student_ps_ids).toBeNull();
  });

  test("a section I do not teach is refused", async () => {
    const res = await open({ section_ps_id: "5002" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("section_not_taught");
  });

  test("a student list within my sections is accepted, de-duplicated", async () => {
    const res = await open({ student_ps_ids: [STUDENT.ps_id, OTHER_STUDENT.ps_id, STUDENT.ps_id] });
    expect(res.status).toBe(201);
    const { test_session } = await res.json();
    expect(test_session.student_ps_ids).toEqual([STUDENT.ps_id, OTHER_STUDENT.ps_id]);
  });

  test("a student list that reaches outside my sections is refused", async () => {
    const res = await open({ student_ps_ids: [STUDENT.ps_id, BIOLOGY_STUDENT.ps_id] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("students_not_taught");
  });

  test("section and list together is a conflict", async () => {
    const res = await open({ section_ps_id: "5001", student_ps_ids: [STUDENT.ps_id] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("scope_conflict");
  });

  test("a session without an email cannot scope at all", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const assessment = await seedAssessment(TEACHER);
    const res = await post({ assessment_id: assessment.id, section_ps_id: "5001" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("section_not_taught");
  });

  test("a sitting narrowed to one section admits only that section at the code", async () => {
    const { test_session } = await (await open({ section_ps_id: "5003" })).json();
    // Ben is in 5001, not 5003.
    principal = studentPrincipal(OTHER_STUDENT.email);
    const refused = await redeem(test_session.code);
    expect(refused.status).toBe(404);
    expect((await refused.json()).error).toBe("session_unavailable");
    // Ada is in 5003.
    principal = studentPrincipal();
    expect((await redeem(test_session.code)).status).toBe(200);
  });

  test("a listed sitting admits exactly the list at the code", async () => {
    const { test_session } = await (await open({ student_ps_ids: [OTHER_STUDENT.ps_id] })).json();
    principal = studentPrincipal();
    expect((await redeem(test_session.code)).status).toBe(404);
    principal = studentPrincipal(OTHER_STUDENT.email);
    expect((await redeem(test_session.code)).status).toBe(200);
  });
});
