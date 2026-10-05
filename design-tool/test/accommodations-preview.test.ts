// U-16: "who gets what" on an assessment — GET /api/assessments/:id/accommodations-preview.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessment_student_overrides,
  assessments,
  student_accommodations,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { studentsInTeachersSections } from "../lib/roster/queries";
import { OTHER_STUDENT, OTHER_TEACHER_EMAIL, STUDENT, TEACHER_EMAIL, clearRoster, seedRoster } from "./helpers/roster";

const TEACHER = "preview-teacher";
const OTHER_TEACHER = "preview-other-teacher";

let principal: { sub: string; role: string; email?: string } | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));
mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

beforeAll(async () => {
  if (!(process.env.DATABASE_URL ?? "").includes("secure_test_design_tool_test")) {
    throw new Error("accommodations-preview tests require the test DB");
  }
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

async function get(id: string) {
  const { GET } = await import("../app/api/assessments/[id]/accommodations-preview/route");
  return GET(new Request("http://localhost/x"), { params: Promise.resolve({ id }) });
}

async function seed() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      name: "Preview",
      allowed_accommodations: ["color_contrast", "spell_check", "zoom"],
      construct_altering: ["spell_check"],
    })
    .returning();
  const [ada, ben, cy, practice, foreign] = await db
    .insert(students)
    .values([
      { owner_sub: TEACHER, name: "Ada", roster_ps_id: STUDENT.ps_id },
      { owner_sub: TEACHER, name: "Ben", roster_ps_id: OTHER_STUDENT.ps_id },
      { owner_sub: TEACHER, name: "Cy" },
      { owner_sub: TEACHER, name: "Practice", practice_for_sub: TEACHER },
      { owner_sub: OTHER_TEACHER, name: "Foreign", roster_ps_id: STUDENT.ps_id },
    ])
    .returning();
  const record = (studentId: string, tool_id: string, value: string, removed = false) => ({
    student_id: studentId,
    subject: "ELA-CAT",
    tool_id,
    value,
    source: "tide_import",
    removed_at: removed ? new Date() : null,
  });
  await db.insert(student_accommodations).values([
    record(ada!.id, "color_contrast", "Black on Rose"),
    record(ada!.id, "tts_test_content", "On"),
    record(ada!.id, "zoom", "2X", true), // withdrawn — not live
    record(ben!.id, "zoom", "2X"),
    record(cy!.id, "optional_font", "Off"), // every tool off → not listed
    record(practice!.id, "zoom", "2X"),
    record(foreign!.id, "zoom", "2X"),
  ]);
  await db.insert(assessment_student_overrides).values([
    { assessment_id: assessment!.id, student_id: ada!.id, tool_id: "spell_check", value: "On", created_by_sub: TEACHER },
    { assessment_id: assessment!.id, student_id: ben!.id, tool_id: "zoom", value: "Off", created_by_sub: TEACHER },
  ]);
  return { assessment: assessment!, ada: ada!, ben: ben! };
}

describe("GET /api/assessments/:id/accommodations-preview", () => {
  test("lists what each student gets and why, the owner's rows only", async () => {
    const { assessment, ada, ben } = await seed();
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
    const res = await get(assessment.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.students.map((s: { name: string }) => s.name)).toEqual(["Ada", "Ben"]);

    const [adaRow, benRow] = body.students;
    expect(adaRow.student_id).toBe(ada.id);
    expect(adaRow.tools).toEqual([
      { tool_id: "color_contrast", value: "Black on Rose", exception: false, construct_altering: false, from_record_of: null },
      { tool_id: "spell_check", value: "On", exception: true, construct_altering: true, from_record_of: null },
    ]);
    expect(adaRow.not_allowed).toEqual([{ tool_id: "tts_test_content", value: "On" }]);
    expect(adaRow.removed_by_exception).toEqual([]);

    expect(benRow.student_id).toBe(ben.id);
    expect(benRow.tools).toEqual([]);
    expect(benRow.removed_by_exception).toEqual(["zoom"]);

    // Everyone on the owner's class lists except Ada (who gets a tool).
    const classList = new Set((await studentsInTeachersSections(getDb(), TEACHER_EMAIL)).map((r) => r.student.ps_id));
    expect(body.others_count).toBe([...classList].filter((id) => id !== STUDENT.ps_id).length);
  });

  test("another teacher is refused", async () => {
    const { assessment } = await seed();
    principal = { sub: OTHER_TEACHER, role: "staff", email: OTHER_TEACHER_EMAIL };
    expect((await get(assessment.id)).status).toBe(404);
  });

  test("an unknown owner email leaves others_count null", async () => {
    const { assessment } = await seed();
    await getDb().execute(sql`update assessments set owner_email = null where id = ${assessment.id}`);
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
    expect((await (await get(assessment.id)).json()).others_count).toBeNull();
  });
});
