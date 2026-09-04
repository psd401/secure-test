// Slice 78: identity from the warehouse roster.
//
// This resolver decides WHICH CHILD a login is and WHETHER they belong in a
// sitting. Binding the wrong row would let a student sit an assessment as
// somebody else and have their answers scored under that name, so the tests
// below lean on the refusal cases at least as hard as the happy path.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { roster_students, students } from "../db/schema";
import {
  resolveStudentForOwner,
  statusForResolutionFailure,
  type SittingScope,
} from "../lib/api/resolveStudent";
import {
  BIOLOGY_STUDENT,
  LEFT_STUDENT,
  NO_SSID_STUDENT,
  OTHER_TEACHER_EMAIL,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`resolve-student tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "resolve-teacher-sub";
const OTHER_TEACHER = "resolve-other-teacher-sub";

const anySection = (owner_email: string | null = TEACHER_EMAIL): SittingScope => ({
  owner_email,
  section_ps_id: null,
  student_ps_ids: null,
});

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  await getDb().execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

const db = () => getDb();

describe("resolveStudentForOwner — who", () => {
  test("no email on the session → no_email", async () => {
    const result = await resolveStudentForOwner(db(), TEACHER, { sub: "x", role: "student" }, anySection());
    expect(result).toEqual({ ok: false, reason: "no_email" });
    for (const email of ["", "   "]) {
      const r = await resolveStudentForOwner(db(), TEACHER, { sub: "x", role: "student", email }, anySection());
      expect(r).toEqual({ ok: false, reason: "no_email" });
    }
  });

  test("an address nobody on the roster carries → not_on_roster", async () => {
    const result = await resolveStudentForOwner(
      db(),
      TEACHER,
      studentPrincipal("nobody@edtools.psd401.net"),
      anySection(),
    );
    expect(result).toEqual({ ok: false, reason: "not_on_roster" });
  });

  test("matches case-insensitively — the importer lowercased, the session might not", async () => {
    const result = await resolveStudentForOwner(
      db(),
      TEACHER,
      studentPrincipal("  Ada.Fixture@EdTools.PSD401.net "),
      anySection(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.roster.ps_id).toBe(STUDENT.ps_id);
  });

  test("a deactivated roster row does not resolve", async () => {
    await db()
      .update(roster_students)
      .set({ is_active: false })
      .where(eq(roster_students.ps_id, STUDENT.ps_id));
    try {
      const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
      expect(result).toEqual({ ok: false, reason: "not_on_roster" });
    } finally {
      await db()
        .update(roster_students)
        .set({ is_active: true })
        .where(eq(roster_students.ps_id, STUDENT.ps_id));
    }
  });

  test("two active roster rows sharing an address → identity_conflict, never a guess", async () => {
    await db()
      .update(roster_students)
      .set({ email: STUDENT.email })
      .where(eq(roster_students.ps_id, "1006"));
    const original = console.warn;
    console.warn = () => {};
    try {
      const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
      expect(result).toEqual({ ok: false, reason: "identity_conflict" });
      expect((await db().select().from(students)).length).toBe(0);
    } finally {
      console.warn = original;
      await db()
        .update(roster_students)
        .set({ email: null })
        .where(eq(roster_students.ps_id, "1006"));
    }
  });
});

describe("resolveStudentForOwner — whether (the sitting's scope)", () => {
  test("admitted when the owner currently teaches a section the student is currently in", async () => {
    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    expect(result.ok).toBe(true);
  });

  test("refused when the owner teaches none of the student's sections", async () => {
    const result = await resolveStudentForOwner(
      db(),
      OTHER_TEACHER,
      studentPrincipal(),
      anySection(OTHER_TEACHER_EMAIL),
    );
    expect(result).toEqual({ ok: false, reason: "not_in_sitting" });
    // And no overlay row was created for the refusal.
    expect((await db().select().from(students)).length).toBe(0);
  });

  test("refused when the student's enrollment in that section has ended", async () => {
    const result = await resolveStudentForOwner(
      db(),
      TEACHER,
      studentPrincipal(LEFT_STUDENT.email),
      anySection(),
    );
    expect(result).toEqual({ ok: false, reason: "not_in_sitting" });
  });

  test("refused when the teacher's assignment to the section has ended", async () => {
    // teacher.three co-taught 5001 until 2021-06-30; Ada is still in 5001.
    const result = await resolveStudentForOwner(
      db(),
      "teacher-three-sub",
      studentPrincipal(),
      anySection("teacher.three@psd401.net"),
    );
    expect(result).toEqual({ ok: false, reason: "not_in_sitting" });
  });

  test("a sitting narrowed to one section admits only that section's students", async () => {
    const inBiology = await resolveStudentForOwner(db(), OTHER_TEACHER, studentPrincipal(BIOLOGY_STUDENT.email), {
      owner_email: OTHER_TEACHER_EMAIL,
      section_ps_id: "5002",
      student_ps_ids: null,
    });
    expect(inBiology.ok).toBe(true);

    // Ada is in 5001 and 5003, both teacher.one's — but not in 5003 when the
    // sitting names 5001? She is in both; narrow to 5003 and check Ben, who
    // is only in 5001.
    const benIn5003 = await resolveStudentForOwner(db(), TEACHER, studentPrincipal("ben.sample@edtools.psd401.net"), {
      owner_email: TEACHER_EMAIL,
      section_ps_id: "5003",
      student_ps_ids: null,
    });
    expect(benIn5003).toEqual({ ok: false, reason: "not_in_sitting" });

    const benIn5001 = await resolveStudentForOwner(db(), TEACHER, studentPrincipal("ben.sample@edtools.psd401.net"), {
      owner_email: TEACHER_EMAIL,
      section_ps_id: "5001",
      student_ps_ids: null,
    });
    expect(benIn5001.ok).toBe(true);
  });

  test("naming a section the owner does not teach admits nobody", async () => {
    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(BIOLOGY_STUDENT.email), {
      owner_email: TEACHER_EMAIL,
      section_ps_id: "5002",
      student_ps_ids: null,
    });
    expect(result).toEqual({ ok: false, reason: "not_in_sitting" });
  });

  test("an explicit student list admits exactly those, with no section check", async () => {
    const listed = await resolveStudentForOwner(db(), OTHER_TEACHER, studentPrincipal(), {
      owner_email: OTHER_TEACHER_EMAIL,
      section_ps_id: null,
      student_ps_ids: [STUDENT.ps_id],
    });
    expect(listed.ok).toBe(true);

    const unlisted = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), {
      owner_email: TEACHER_EMAIL,
      section_ps_id: null,
      student_ps_ids: ["1002"],
    });
    expect(unlisted).toEqual({ ok: false, reason: "not_in_sitting" });

    const empty = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), {
      owner_email: TEACHER_EMAIL,
      section_ps_id: null,
      student_ps_ids: [],
    });
    expect(empty).toEqual({ ok: false, reason: "not_in_sitting" });
  });

  test("a sitting with no owner email (pre-slice-78) admits nobody by section", async () => {
    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection(null));
    expect(result).toEqual({ ok: false, reason: "not_in_sitting" });
  });
});

describe("resolveStudentForOwner — as whom (the accommodations overlay)", () => {
  test("an admitted first join creates the teacher's overlay row from the roster", async () => {
    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newlyBound).toBe(true);
    expect(result.student.owner_sub).toBe(TEACHER);
    expect(result.student.roster_ps_id).toBe(STUDENT.ps_id);
    expect(result.student.ssid).toBe(STUDENT.ssid);
    expect(result.student.name).toBe(STUDENT.name);
    expect(result.student.grade).toBe("9");

    const again = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.newlyBound).toBe(false);
      expect(again.student.id).toBe(result.student.id);
    }
    expect((await db().select().from(students)).length).toBe(1);
  });

  test("a TIDE-imported row (by SSID) is bound, not duplicated, and gets a name", async () => {
    const [tide] = await db()
      .insert(students)
      .values({ owner_sub: TEACHER, ssid: STUDENT.ssid, name: "" })
      .returning();

    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.student.id).toBe(tide!.id);
    expect(result.newlyBound).toBe(true);
    expect(result.student.roster_ps_id).toBe(STUDENT.ps_id);
    expect(result.student.name).toBe(STUDENT.name);

    const [row] = await db().select().from(students).where(eq(students.id, tide!.id));
    expect(row?.roster_ps_id).toBe(STUDENT.ps_id);
    expect((await db().select().from(students)).length).toBe(1);
  });

  test("a teacher-typed name on the TIDE row is kept", async () => {
    await db().insert(students).values({ owner_sub: TEACHER, ssid: STUDENT.ssid, name: "Ada F." });
    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.student.name).toBe("Ada F.");
  });

  test("an SSID row already bound to a different roster student → identity_conflict", async () => {
    await db()
      .insert(students)
      .values({ owner_sub: TEACHER, ssid: STUDENT.ssid, roster_ps_id: "9999", name: "Somebody" });
    const result = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    expect(result).toEqual({ ok: false, reason: "identity_conflict" });
    const rows = await db().select().from(students);
    expect(rows.length).toBe(1);
    expect(rows[0]?.roster_ps_id).toBe("9999");
  });

  test("a student with no SSID yet still gets an overlay row, keyed by ps_id", async () => {
    const result = await resolveStudentForOwner(
      db(),
      "teacher-four-sub",
      studentPrincipal(NO_SSID_STUDENT.email),
      anySection(NO_SSID_STUDENT.teacherEmail),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.student.ssid).toBeNull();
    expect(result.student.roster_ps_id).toBe(NO_SSID_STUDENT.ps_id);
  });

  test("the overlay is per teacher: two owners, two rows, never crossed", async () => {
    const mine = await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    const theirs = await resolveStudentForOwner(db(), OTHER_TEACHER, studentPrincipal(), {
      owner_email: OTHER_TEACHER_EMAIL,
      section_ps_id: null,
      student_ps_ids: [STUDENT.ps_id],
    });
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;
    expect(mine.student.id).not.toBe(theirs.student.id);
    expect(mine.student.owner_sub).toBe(TEACHER);
    expect(theirs.student.owner_sub).toBe(OTHER_TEACHER);
  });

  test("without a sitting, an existing overlay row is found but none is created", async () => {
    // Delivery and attempt routes resolve without a sitting; a probe must
    // not leave a row on the teacher's accommodations roster.
    const probe = await resolveStudentForOwner(db(), TEACHER, studentPrincipal());
    expect(probe).toEqual({ ok: false, reason: "not_on_roster" });
    expect((await db().select().from(students)).length).toBe(0);

    await resolveStudentForOwner(db(), TEACHER, studentPrincipal(), anySection());
    const found = await resolveStudentForOwner(db(), TEACHER, studentPrincipal());
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.newlyBound).toBe(false);
  });

  test("without a sitting, a TIDE row is still bound by SSID", async () => {
    await db().insert(students).values({ owner_sub: TEACHER, ssid: STUDENT.ssid, name: "" });
    const found = await resolveStudentForOwner(db(), TEACHER, studentPrincipal());
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.newlyBound).toBe(true);
  });
});

describe("statusForResolutionFailure", () => {
  test("maps each reason to its status", () => {
    expect(statusForResolutionFailure("no_email")).toBe(403);
    expect(statusForResolutionFailure("not_on_roster")).toBe(404);
    expect(statusForResolutionFailure("not_in_sitting")).toBe(404);
    expect(statusForResolutionFailure("identity_conflict")).toBe(409);
  });
});
