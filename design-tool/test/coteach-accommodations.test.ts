// U-17 (docs/coteach-and-section-accommodations-design.md): co-teachers'
// accommodation records count, and F-1 — a co-teacher's exceptions attach to
// the owner's row.
//
// Fixture roster: teacher.two leads 5002 (Cy, 1003); teacher.one leads 5001
// (Ada 1001, Ben 1002) and 5003 (Ada). Here teacher.two OWNS the assessment
// and teacher.one is the co-teacher by grant.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessment_student_overrides,
  assessments,
  student_accommodations,
  students,
  type AssessmentRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { resolveEffectiveAccommodations } from "../lib/accommodations/effective";
import {
  coTeacherRecordStudentIds,
  stampOverlayOwnerEmail,
} from "../lib/accommodations/coTeacherRecords";
import { buildAccommodationsPreview } from "../lib/accommodations/preview";
import {
  BIOLOGY_STUDENT,
  OTHER_STUDENT,
  OTHER_TEACHER_EMAIL,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
} from "./helpers/roster";

const OWNER = "coteach-owner"; // teacher.two
const CO = "coteach-co"; // teacher.one
const STRANGER = "coteach-stranger";

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
    throw new Error("coteach-accommodations tests require the test DB");
  }
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function seedAssessment(opts: { grant?: "live" | "revoked" | "none" } = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      owner_email: OTHER_TEACHER_EMAIL,
      name: "Co-taught",
      allowed_accommodations: ["color_contrast", "spell_check", "zoom"],
    })
    .returning();
  if ((opts.grant ?? "live") !== "none") {
    await db.insert(access_grants).values({
      grantee_email: TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: assessment!.id,
      level: "edit",
      granted_by_sub: OWNER,
      granted_by_email: OTHER_TEACHER_EMAIL,
      revoked_at: opts.grant === "revoked" ? new Date() : null,
    });
  }
  return assessment as AssessmentRow;
}

async function overlay(owner: string, email: string | null, values: Partial<typeof students.$inferInsert>) {
  const [row] = await getDb()
    .insert(students)
    .values({ owner_sub: owner, owner_email: email, name: "", ...values })
    .returning();
  return row!;
}

async function record(studentId: string, tool_id: string, value: string) {
  await getDb()
    .insert(student_accommodations)
    .values({ student_id: studentId, subject: "ELA", tool_id, value, source: "manual" });
}

async function postException(assessmentId: string, body: Record<string, unknown>) {
  const { POST } = await import("../app/api/assessments/[id]/overrides/route");
  return POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

describe("U-17: co-teachers' records count", () => {
  test("unioned with the owner's; On wins; the owner's value wins a conflict", async () => {
    const a = await seedAssessment();
    const own = await overlay(OWNER, OTHER_TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id });
    const co = await overlay(CO, TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id });
    await record(own.id, "color_contrast", "Black on Rose");
    await record(own.id, "spell_check", "Off");
    await record(co.id, "color_contrast", "Yellow on Black");
    await record(co.id, "spell_check", "On");
    await record(co.id, "zoom", "2X");

    const coIds = await coTeacherRecordStudentIds(getDb(), a, STUDENT.ps_id);
    expect(coIds).toEqual([co.id]);
    const result = await resolveEffectiveAccommodations(getDb(), a, own.id, coIds);
    expect(result.enabled).toEqual({ color_contrast: "Black on Rose", spell_check: "On", zoom: "2X" });
  });

  test("an Off exception still withdraws a co-teacher's tool", async () => {
    const a = await seedAssessment();
    const own = await overlay(OWNER, OTHER_TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id });
    const co = await overlay(CO, TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id });
    await record(co.id, "zoom", "2X");
    await getDb().insert(assessment_student_overrides).values({
      assessment_id: a.id,
      student_id: own.id,
      tool_id: "zoom",
      value: "Off",
      created_by_sub: OWNER,
    });
    const coIds = await coTeacherRecordStudentIds(getDb(), a, STUDENT.ps_id);
    expect((await resolveEffectiveAccommodations(getDb(), a, own.id, coIds)).enabled).toEqual({});
  });

  test("only while the co-teacher currently teaches the child (13.1)", async () => {
    const a = await seedAssessment();
    // teacher.one does not teach Cy (5002 is teacher.two's alone).
    await overlay(CO, TEACHER_EMAIL, { roster_ps_id: BIOLOGY_STUDENT.ps_id });
    expect(await coTeacherRecordStudentIds(getDb(), a, BIOLOGY_STUDENT.ps_id)).toEqual([]);
  });

  test("no grant, or a revoked one, means no co-teacher", async () => {
    for (const grant of ["none", "revoked"] as const) {
      const a = await seedAssessment({ grant });
      await overlay(CO, TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id });
      expect(await coTeacherRecordStudentIds(getDb(), a, STUDENT.ps_id)).toEqual([]);
      await getDb().execute(sql`truncate table assessments, students, access_grants restart identity cascade`);
    }
  });

  test("a co-teacher's unbound TIDE row is matched by the roster SSID", async () => {
    const a = await seedAssessment();
    const co = await overlay(CO, TEACHER_EMAIL, { ssid: OTHER_STUDENT.ssid });
    expect(await coTeacherRecordStudentIds(getDb(), a, OTHER_STUDENT.ps_id)).toEqual([co.id]);
  });

  test("the preview unions them, marks the source, and lists a co-teacher-only child", async () => {
    const a = await seedAssessment();
    const own = await overlay(OWNER, OTHER_TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id, name: "Ada" });
    const coAda = await overlay(CO, TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id, name: "Ada" });
    const coBen = await overlay(CO, TEACHER_EMAIL, { ssid: OTHER_STUDENT.ssid, name: "Ben" });
    await record(own.id, "color_contrast", "Black on Rose");
    await record(coAda.id, "spell_check", "On");
    await record(coBen.id, "zoom", "2X");

    const preview = await buildAccommodationsPreview(getDb(), a);
    expect(preview.students.map((s) => s.name)).toEqual(["Ada", "Ben"]);
    const [ada, ben] = preview.students;
    expect(ada!.student_id).toBe(own.id);
    expect(ada!.tools.map((t) => [t.tool_id, t.from_record_of])).toEqual([
      ["color_contrast", null],
      ["spell_check", TEACHER_EMAIL],
    ]);
    expect(ben!.roster_ps_id).toBe(OTHER_STUDENT.ps_id);
    expect(ben!.tools.map((t) => [t.tool_id, t.from_record_of])).toEqual([["zoom", TEACHER_EMAIL]]);
  });
});

describe("F-1: a co-teacher's exception attaches to the owner's row", () => {
  test("the co-teacher's own row is mapped to the owner's, created if missing", async () => {
    const a = await seedAssessment();
    const coBen = await overlay(CO, TEACHER_EMAIL, { roster_ps_id: OTHER_STUDENT.ps_id, name: "Ben" });
    principal = { sub: CO, role: "staff", email: TEACHER_EMAIL };
    const res = await postException(a.id, { student_id: coBen.id, tool_id: "spell_check", value: "On" });
    expect(res.status).toBe(201);
    const { override } = (await res.json()) as { override: { student_id: string } };
    const [target] = await getDb().select().from(students).where(eq(students.id, override.student_id));
    expect(target!.owner_sub).toBe(OWNER);
    expect(target!.roster_ps_id).toBe(OTHER_STUDENT.ps_id);
    expect(target!.owner_email).toBe(OTHER_TEACHER_EMAIL);

    // Delivery's rule now applies it.
    const result = await resolveEffectiveAccommodations(getDb(), a, target!.id);
    expect(result.enabled).toEqual({ spell_check: "On" });

    // A second exception reuses the same owner row.
    const again = await postException(a.id, { student_id: coBen.id, tool_id: "zoom", value: "2X" });
    expect(((await again.json()) as { override: { student_id: string } }).override.student_id).toBe(target!.id);
  });

  test("the owner's row can be named directly by a co-teacher", async () => {
    const a = await seedAssessment();
    const own = await overlay(OWNER, OTHER_TEACHER_EMAIL, { roster_ps_id: STUDENT.ps_id });
    principal = { sub: CO, role: "staff", email: TEACHER_EMAIL };
    const res = await postException(a.id, { student_id: own.id, tool_id: "zoom", value: "2X" });
    expect(res.status).toBe(201);
  });

  test("an unlinked row is 400, someone else's row is 404", async () => {
    const a = await seedAssessment();
    const unlinked = await overlay(CO, TEACHER_EMAIL, { ssid: "WA-NOT-ON-ROSTER" });
    const foreign = await overlay(STRANGER, null, { roster_ps_id: STUDENT.ps_id });
    principal = { sub: CO, role: "staff", email: TEACHER_EMAIL };
    const r1 = await postException(a.id, { student_id: unlinked.id, tool_id: "zoom", value: "2X" });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toBe("student_not_linked");
    const r2 = await postException(a.id, { student_id: foreign.id, tool_id: "zoom", value: "2X" });
    expect(r2.status).toBe(404);
  });
});

describe("13.3: owner_email stamp", () => {
  test("fills only the caller's rows that lack it", async () => {
    const blank = await overlay(CO, null, { ssid: "A" });
    const other = await overlay(CO, "kept@psd401.net", { ssid: "B" });
    const foreign = await overlay(STRANGER, null, { ssid: "C" });
    await stampOverlayOwnerEmail(getDb(), CO, "  Teacher.One@PSD401.net ");
    const rows = new Map(
      (await getDb().select().from(students)).map((r) => [r.id, r.owner_email]),
    );
    expect(rows.get(blank.id)).toBe(TEACHER_EMAIL);
    expect(rows.get(other.id)).toBe("kept@psd401.net");
    expect(rows.get(foreign.id)).toBeNull();
  });
});
