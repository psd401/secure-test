// U-18 (docs/coteach-and-section-accommodations-design.md): accommodations by
// class period — the rule, write validation, delivery's section choice, the
// preview's ?section=, and copies leaving it behind.
//
// Fixture roster: teacher.one leads 5001 (Ada 1001, Ben 1002) and 5003 (Ada).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessment_student_overrides,
  assessments,
  student_accommodations,
  students,
  test_sessions,
  type AssessmentRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { explainAccommodations, resolveEffectiveAccommodations } from "../lib/accommodations/effective";
import {
  ruleForSections,
  sectionsForAttempt,
  validateSectionAccommodations,
  type SectionAccommodations,
} from "../lib/accommodations/sections";
import { buildAccommodationsPreview } from "../lib/accommodations/preview";
import { buildExportBundle } from "../lib/api/exportBundle";
import { duplicateAssessment } from "../lib/api/duplicateAssessment";
import { OTHER_STUDENT, STUDENT, TEACHER_EMAIL, clearRoster, seedRoster } from "./helpers/roster";

const TEACHER = "section-acc-teacher";
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
    throw new Error("section-accommodations tests require the test DB");
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

const rule = (sections: SectionAccommodations, scope = "teacher") => ({
  allowed_accommodations: ["color_contrast", "spell_check", "zoom"],
  construct_altering: [] as string[],
  assigned_scope: scope,
  section_accommodations: sections,
});

describe("ruleForSections", () => {
  test("no configured period: the test's list, no grants", () => {
    const r = ruleForSections(rule({ "5003": { allowed: ["zoom"], grants: [] } }), ["5001"]);
    expect(r.allowed_accommodations).toEqual(["color_contrast", "spell_check", "zoom"]);
    expect(r.grants).toEqual([]);
  });

  test("a period's list replaces the test's; null keeps it; grants come along", () => {
    const cfg: SectionAccommodations = {
      "5001": { allowed: ["zoom", "tts_test_content"], grants: [{ tool_id: "zoom", value: "2X" }] },
      "5003": { allowed: null, grants: [{ tool_id: "spell_check", value: "On" }] },
    };
    const a = ruleForSections(rule(cfg), ["5001"]);
    expect([...(a.allowed_accommodations as string[])].sort()).toEqual(["tts_test_content", "zoom"]);
    expect(a.grants).toEqual([{ tool_id: "zoom", value: "2X" }]);
    const b = ruleForSections(rule(cfg), ["5003"]);
    expect([...(b.allowed_accommodations as string[])].sort()).toEqual(["color_contrast", "spell_check", "zoom"]);
    expect(b.grants).toEqual([{ tool_id: "spell_check", value: "On" }]);
  });

  test("two configured periods union their lists and grants", () => {
    const r = ruleForSections(
      rule({
        "5001": { allowed: ["zoom"], grants: [{ tool_id: "zoom", value: "2X" }] },
        "5003": { allowed: ["spell_check"], grants: [{ tool_id: "spell_check", value: "On" }] },
      }),
      ["5001", "5003"],
    );
    expect([...(r.allowed_accommodations as string[])].sort()).toEqual(["spell_check", "zoom"]);
    expect(r.grants?.map((g) => g.tool_id).sort()).toEqual(["spell_check", "zoom"]);
  });

  test("on a district test a period cannot widen the test's list", () => {
    const r = ruleForSections(rule({ "5001": { allowed: ["zoom", "tts_test_content"], grants: [] } }, "district"), [
      "5001",
    ]);
    expect(r.allowed_accommodations).toEqual(["zoom"]);
  });
});

describe("explainAccommodations with period grants", () => {
  const base = { allowed_accommodations: ["zoom", "spell_check"], construct_altering: [] as string[], assigned_scope: "teacher" };

  test("a grant adds a tool; the record's own value wins; an Off exception removes it", () => {
    const r = explainAccommodations(
      { ...base, grants: [{ tool_id: "zoom", value: "2X" }, { tool_id: "spell_check", value: "On" }] },
      [{ tool_id: "zoom", value: "3X" }],
      [{ tool_id: "spell_check", value: "Off" }],
    );
    expect(r.enabled).toEqual({ zoom: "3X" });
    expect(r.grantedBySection).toEqual([]);
    expect(r.removedByException).toEqual(["spell_check"]);
  });

  test("grantedBySection names what the grant supplied", () => {
    const r = explainAccommodations({ ...base, grants: [{ tool_id: "spell_check", value: "On" }] }, [], []);
    expect(r.enabled).toEqual({ spell_check: "On" });
    expect(r.grantedBySection).toEqual(["spell_check"]);
  });
});

describe("validateSectionAccommodations", () => {
  const ok = (v: SectionAccommodations, scope = "teacher") =>
    validateSectionAccommodations(v, ["zoom", "spell_check"], scope);

  test("accepts a teacher-test period that widens, with grants it allows", () => {
    expect(ok({ "5001": { allowed: ["zoom", "tts_test_content"], grants: [{ tool_id: "tts_test_content", value: "On" }] } }))
      .toEqual({ ok: true });
  });

  test("refuses widening on a district test, a grant outside the period, an Off grant, a repeat", () => {
    expect(ok({ "5001": { allowed: ["tts_test_content"], grants: [] } }, "district")).toMatchObject({
      error: "section_allowed_must_be_subset",
      tool_id: "tts_test_content",
    });
    expect(ok({ "5001": { allowed: ["zoom"], grants: [{ tool_id: "spell_check", value: "On" }] } })).toMatchObject({
      error: "grant_not_allowed",
    });
    expect(ok({ "5001": { allowed: null, grants: [{ tool_id: "zoom", value: "Off" }] } })).toMatchObject({
      error: "grant_value_off",
    });
    expect(
      ok({ "5001": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }, { tool_id: "zoom", value: "3X" }] } }),
    ).toMatchObject({ error: "grant_repeated" });
  });
});

async function seed(sections: SectionAccommodations) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      name: "By period",
      allowed_accommodations: ["color_contrast", "spell_check", "zoom"],
      section_accommodations: sections,
    })
    .returning();
  return a as AssessmentRow;
}

async function sitting(assessmentId: string, section: string | null) {
  const [row] = await getDb()
    .insert(test_sessions)
    .values({
      assessment_id: assessmentId,
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      section_ps_id: section,
      code: `C${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return row!;
}

describe("delivery's period choice (D-8)", () => {
  const cfg: SectionAccommodations = {
    "5001": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] },
    "5003": { allowed: ["spell_check"], grants: [{ tool_id: "spell_check", value: "On" }] },
  };

  test("the sitting's period when it names one, else the student's configured periods", async () => {
    const a = await seed(cfg);
    const [ada] = await getDb()
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();

    const in5003 = await sitting(a.id, "5003");
    const s1 = await sectionsForAttempt(getDb(), a, { test_session_id: in5003.id }, STUDENT.ps_id);
    expect(s1).toEqual(["5003"]);
    expect((await resolveEffectiveAccommodations(getDb(), a, ada!.id, [], s1)).enabled).toEqual({ spell_check: "On" });

    const all = await sitting(a.id, null);
    const s2 = await sectionsForAttempt(getDb(), a, { test_session_id: all.id }, STUDENT.ps_id);
    expect(s2).toEqual(["5001", "5003"]);
    expect((await resolveEffectiveAccommodations(getDb(), a, ada!.id, [], s2)).enabled).toEqual({
      spell_check: "On",
      zoom: "2X",
    });
  });

  test("no configuration: no periods, the test's rule", async () => {
    const a = await seed({});
    expect(await sectionsForAttempt(getDb(), a, { test_session_id: null }, STUDENT.ps_id)).toEqual([]);
  });
});

async function patch(id: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  return PATCH(
    new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH section_accommodations", () => {
  test("saves a valid value, refuses an invalid one, locked while Published", async () => {
    const a = await seed({});
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
    const good = { "5001": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] } };
    const res = await patch(a.id, { section_accommodations: good });
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, a.id));
    expect(row!.section_accommodations).toEqual(good);

    const bad = await patch(a.id, {
      section_accommodations: { "5001": { allowed: ["zoom"], grants: [{ tool_id: "spell_check", value: "On" }] } },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "grant_not_allowed", section_ps_id: "5001", tool_id: "spell_check" });

    await getDb().update(assessments).set({ status: "published" }).where(eq(assessments.id, a.id));
    expect((await patch(a.id, { section_accommodations: {} })).status).toBe(409);
  });
});

describe("preview ?section=", () => {
  test("only that period's students, under its rule, with the grant flagged", async () => {
    const a = await seed({ "5003": { allowed: ["spell_check", "zoom"], grants: [{ tool_id: "spell_check", value: "On" }] } });
    const db = getDb();
    const [ada, ben] = await db
      .insert(students)
      .values([
        { owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" },
        { owner_sub: TEACHER, roster_ps_id: OTHER_STUDENT.ps_id, name: "Ben" },
      ])
      .returning();
    await db.insert(student_accommodations).values([
      { student_id: ada!.id, subject: "ELA", tool_id: "color_contrast", value: "Black on Rose", source: "manual" },
      { student_id: ben!.id, subject: "ELA", tool_id: "zoom", value: "2X", source: "manual" },
    ]);

    const p5003 = await buildAccommodationsPreview(db, a, { section: "5003" });
    expect(p5003.students.map((s) => s.name)).toEqual(["Ada"]); // Ben is not in 5003
    expect(p5003.students[0]!.tools).toEqual([
      { tool_id: "spell_check", value: "On", exception: false, construct_altering: false, from_record_of: null, from_section: true },
    ]);
    expect(p5003.students[0]!.not_allowed).toEqual([{ tool_id: "color_contrast", value: "Black on Rose" }]);
    expect(p5003.others_count).toBe(0); // Ada is the period's only student and she gets a tool

    // An Off exception removes the period grant for Ada.
    await db.insert(assessment_student_overrides).values({
      assessment_id: a.id,
      student_id: ada!.id,
      tool_id: "spell_check",
      value: "Off",
      created_by_sub: TEACHER,
    });
    const after = await buildAccommodationsPreview(db, a, { section: "5003" });
    expect(after.students[0]!.tools).toEqual([]);
    expect(after.students[0]!.removed_by_exception).toEqual(["spell_check"]);
  });
});

describe("copies leave per-period settings behind (13.10)", () => {
  test("export bundle and Duplicate", async () => {
    const a = await seed({ "5001": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] } });
    const built = await buildExportBundle(getDb(), a, TEACHER, true);
    expect(built.ok).toBe(true);
    if (built.ok) expect(JSON.stringify(built.bundle)).not.toContain("section_accommodations");

    const dup = await duplicateAssessment(getDb(), a, TEACHER, TEACHER_EMAIL);
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    const [copy] = await getDb().select().from(assessments).where(eq(assessments.id, dup.assessment_id));
    expect(copy!.section_accommodations).toEqual({});
    expect(copy!.allowed_accommodations).toEqual(["color_contrast", "spell_check", "zoom"]);
  });
});

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

describe("17.2: an exception may name a tool the student's period allows", () => {
  test("allowed for a student in that period, refused otherwise; nothing created on an early refusal", async () => {
    const a = await seed({ "5003": { allowed: ["tts_test_content"], grants: [] } });
    const db = getDb();
    const [ada, ben] = await db
      .insert(students)
      .values([
        { owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" }, // in 5003
        { owner_sub: TEACHER, roster_ps_id: OTHER_STUDENT.ps_id, name: "Ben" }, // not in 5003
      ])
      .returning();
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };

    expect((await postException(a.id, { student_id: ada!.id, tool_id: "tts_test_content", value: "On" })).status).toBe(201);
    const refused = await postException(a.id, { student_id: ben!.id, tool_id: "tts_test_content", value: "On" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("tool_not_in_allowed_accommodations");

    const before = (await db.select().from(students)).length;
    expect((await postException(a.id, { student_id: ada!.id, tool_id: "optional_font", value: "On" })).status).toBe(400);
    expect((await db.select().from(students)).length).toBe(before);
  });

  test("shrinking the test's list keeps exceptions a period still allows", async () => {
    const a = await seed({ "5003": { allowed: ["zoom"], grants: [] } });
    const db = getDb();
    const [ada] = await db.insert(students).values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" }).returning();
    await db.insert(assessment_student_overrides).values([
      { assessment_id: a.id, student_id: ada!.id, tool_id: "zoom", value: "2X", created_by_sub: TEACHER },
      { assessment_id: a.id, student_id: ada!.id, tool_id: "spell_check", value: "On", created_by_sub: TEACHER },
    ]);
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
    expect((await patch(a.id, { allowed_accommodations: ["color_contrast"] })).status).toBe(200);
    const left = await db
      .select({ tool_id: assessment_student_overrides.tool_id })
      .from(assessment_student_overrides)
      .where(eq(assessment_student_overrides.assessment_id, a.id));
    expect(left.map((r) => r.tool_id)).toEqual(["zoom"]);
  });
});

describe("GET section-options (13.9)", () => {
  test("the owner's current periods, plus a configured period no longer on the roster", async () => {
    const a = await seed({ "9999": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] } });
    principal = { sub: TEACHER, role: "staff", email: TEACHER_EMAIL };
    const { GET } = await import("../app/api/assessments/[id]/section-options/route");
    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: a.id }) });
    const { sections } = (await res.json()) as {
      sections: { ps_id: string; on_roster: boolean; configured: boolean }[];
    };
    const byId = new Map(sections.map((s) => [s.ps_id, s]));
    expect(byId.get("5001")).toMatchObject({ on_roster: true, configured: false });
    expect(byId.get("5003")).toMatchObject({ on_roster: true, configured: false });
    expect(byId.get("9999")).toMatchObject({ on_roster: false, configured: true });
  });
});

describe("preview lists a granted period's students who have no record", () => {
  test("named from the roster, the grant flagged, none left over", async () => {
    const a = await seed({ "5001": { allowed: null, grants: [{ tool_id: "zoom", value: "2X" }] } });
    const p = await buildAccommodationsPreview(getDb(), a, { section: "5001" });
    // 5001's current students in the fixture: Ada and Ben (no overlay rows).
    expect(p.students.map((s) => s.roster_ps_id).sort()).toEqual([STUDENT.ps_id, OTHER_STUDENT.ps_id].sort());
    expect(p.students.every((s) => s.student_id.startsWith("roster:"))).toBe(true);
    expect(p.students[0]!.tools).toEqual([
      { tool_id: "zoom", value: "2X", exception: false, construct_altering: false, from_record_of: null, from_section: true },
    ]);
    expect(p.others_count).toBe(0);
  });
});

