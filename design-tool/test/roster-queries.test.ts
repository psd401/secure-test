// Slice 79: the query layer behind the teacher's roster page and the
// sections endpoint, against the fictional warehouse fixture.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { student_accommodations, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  sectionsCurrentlyTaughtBy,
  studentIsInTeachersSection,
  studentsInTeachersSections,
} from "../lib/roster/queries";
import { sectionLabel, studentDisplayName, teacherRoster } from "../lib/roster/teacherRoster";
import {
  OTHER_TEACHER_EMAIL,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  type TestPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`roster-queries tests require the test DB; got: ${url}`);
  }
};

let principal: TestPrincipal | null = null;

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

const TEACHER = "queries-teacher-sub";

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  await getDb().execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

const db = () => getDb();

describe("sectionsCurrentlyTaughtBy", () => {
  test("lists the sections a teacher is currently assigned to, sorted", async () => {
    const mine = await sectionsCurrentlyTaughtBy(db(), TEACHER_EMAIL);
    expect(mine.map((s) => s.ps_id)).toEqual(["5001", "5003"]);
    expect(mine[0]?.course_name).toBe("Algebra 1");
  });

  test("an ended assignment does not count", async () => {
    // teacher.three co-taught 5001 until 2021-06-30.
    expect(await sectionsCurrentlyTaughtBy(db(), "teacher.three@psd401.net")).toEqual([]);
  });

  test("an unknown email has no sections", async () => {
    expect(await sectionsCurrentlyTaughtBy(db(), "nobody@psd401.net")).toEqual([]);
  });
});

describe("studentsInTeachersSections", () => {
  test("returns one row per (student, section), current enrollments only", async () => {
    const rows = await studentsInTeachersSections(db(), TEACHER_EMAIL);
    const pairs = rows.map((r) => `${r.section.ps_id}:${r.student.ps_id}`);
    // 5001: Ada, Ben (Dee left 2021; Gus left 2021). 5003: Ada.
    expect(pairs).toEqual(["5001:1001", "5001:1002", "5003:1001"]);
  });

  test("narrows to one section", async () => {
    const rows = await studentsInTeachersSections(db(), TEACHER_EMAIL, "5003");
    expect(rows.map((r) => r.student.ps_id)).toEqual(["1001"]);
  });

  test("a section the teacher does not teach yields nothing", async () => {
    expect(await studentsInTeachersSections(db(), TEACHER_EMAIL, "5002")).toEqual([]);
  });
});

describe("studentIsInTeachersSection", () => {
  test("true only for a current enrollment under a current assignment", async () => {
    expect(await studentIsInTeachersSection(db(), "1001", TEACHER_EMAIL)).toBe(true);
    expect(await studentIsInTeachersSection(db(), "1003", TEACHER_EMAIL)).toBe(false);
    expect(await studentIsInTeachersSection(db(), "1004", TEACHER_EMAIL)).toBe(false);
    expect(await studentIsInTeachersSection(db(), "1001", "teacher.three@psd401.net")).toBe(false);
    expect(await studentIsInTeachersSection(db(), "1002", TEACHER_EMAIL, "5003")).toBe(false);
    expect(await studentIsInTeachersSection(db(), "1002", TEACHER_EMAIL, "5001")).toBe(true);
  });
});

describe("teacherRoster", () => {
  test("groups roster students by section and joins the overlay by ps_id or SSID", async () => {
    // Ada: bound overlay row with one accommodation. Ben: TIDE row by SSID,
    // unbound. A third overlay row matches nobody in these sections.
    const [ada] = await db()
      .insert(students)
      .values({ owner_sub: TEACHER, ssid: STUDENT.ssid, roster_ps_id: STUDENT.ps_id, name: "Ada Fixture" })
      .returning();
    await db().insert(student_accommodations).values({
      student_id: ada!.id,
      subject: "Mathematics",
      tool_id: "spell_check",
      value: "on",
      source: "manual",
    });
    await db().insert(students).values({ owner_sub: TEACHER, ssid: "WA-FIX-1002", name: "" });
    await db().insert(students).values({ owner_sub: TEACHER, ssid: "WA-ELSEWHERE", name: "Someone Else" });

    const roster = await teacherRoster(db(), TEACHER, TEACHER_EMAIL);
    expect(roster.teacherEmail).toBe(TEACHER_EMAIL);
    expect(roster.sections.map((s) => s.section.ps_id)).toEqual(["5001", "5003"]);

    const algebra = roster.sections[0]!;
    expect(algebra.students.map((s) => s.roster.ps_id)).toEqual(["1001", "1002"]);
    expect(algebra.students[0]?.overlay?.accommodation_count).toBe(1);
    expect(algebra.students[0]?.overlay?.id).toBe(ada!.id);
    expect(algebra.students[1]?.overlay?.ssid).toBe("WA-FIX-1002");
    expect(algebra.students[1]?.overlay?.accommodation_count).toBe(0);

    const english = roster.sections[1]!;
    expect(english.students.map((s) => s.roster.ps_id)).toEqual(["1001"]);
    expect(english.students[0]?.overlay?.id).toBe(ada!.id);

    expect(roster.unlinked.map((o) => o.ssid)).toEqual(["WA-ELSEWHERE"]);
  });

  test("a roster student with no overlay row shows null, not a fabricated row", async () => {
    const roster = await teacherRoster(db(), TEACHER, TEACHER_EMAIL);
    for (const s of roster.sections.flatMap((x) => x.students)) {
      expect(s.overlay).toBeNull();
    }
    expect((await db().select().from(students)).length).toBe(0);
  });

  test("another teacher's overlay rows are never shown", async () => {
    await db().insert(students).values({ owner_sub: "someone-else", ssid: STUDENT.ssid, name: "Theirs" });
    const roster = await teacherRoster(db(), TEACHER, TEACHER_EMAIL);
    expect(roster.sections[0]?.students[0]?.overlay).toBeNull();
    expect(roster.unlinked).toEqual([]);
  });

  test("no email → no sections, overlay listed as unlinked", async () => {
    await db().insert(students).values({ owner_sub: TEACHER, ssid: "WA-X", name: "X" });
    const roster = await teacherRoster(db(), TEACHER, undefined);
    expect(roster.teacherEmail).toBeNull();
    expect(roster.sections).toEqual([]);
    expect(roster.unlinked.length).toBe(1);
  });

  test("labels", () => {
    expect(
      sectionLabel({
        ps_id: "1",
        course_name: "Biology",
        course_code: "SCI201",
        period_expression: "4(A)",
      } as never),
    ).toBe("Biology · 4(A)");
    expect(
      sectionLabel({ ps_id: "1", course_name: "", course_code: "SCI201", period_expression: "" } as never),
    ).toBe("SCI201");
    expect(studentDisplayName({ first_name: "Ada", last_name: "Fixture", ps_id: "1" } as never)).toBe(
      "Fixture, Ada",
    );
    expect(studentDisplayName({ first_name: "", last_name: "", ps_id: "77" } as never)).toBe("77");
  });
});

describe("GET /api/roster/sections", () => {
  async function get() {
    const { GET } = await import("../app/api/roster/sections/route");
    return GET();
  }

  test("the teacher's current sections with head-counts", async () => {
    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const res = await get();
    expect(res.status).toBe(200);
    const { sections } = await res.json();
    expect(sections).toEqual([
      expect.objectContaining({ ps_id: "5001", course_name: "Algebra 1", student_count: 2 }),
      expect.objectContaining({ ps_id: "5003", course_name: "English 9", student_count: 1 }),
    ]);
  });

  test("another teacher sees their own", async () => {
    principal = staffPrincipal("other-sub", OTHER_TEACHER_EMAIL);
    const { sections } = await (await get()).json();
    expect(sections.map((s: { ps_id: string }) => s.ps_id)).toEqual(["5002"]);
  });

  test("a session without an email gets an empty list, not an error", async () => {
    principal = { sub: TEACHER, role: "staff" };
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sections: [] });
  });
});
