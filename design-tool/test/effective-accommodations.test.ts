// Slice 62: which accommodations a specific student actually gets on a specific
// assessment.
//
// Everything this merges has existed for slices — the TIDE import, the OSPI
// catalog, the per-assessment overrides UI — and none of it had ever reached a
// student. A child with a documented IEP accommodation would have sat the test
// without it. These tests are weighted toward the cases where getting it wrong
// silently removes a support.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessment_student_overrides,
  assessments,
  student_accommodations,
  students,
  type AssessmentRow,
} from "../db/schema";
import {
  isEnabledValue,
  resolveEffectiveAccommodations,
} from "../lib/accommodations/effective";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`effective-accommodations tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "acc-teacher";

beforeAll(() => expectTestDb());
afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});
afterAll(async () => await closeDb());

async function seed(
  allowed: string[],
  constructAltering: string[] = [],
  assignedScope: "teacher" | "school" | "district" = "teacher",
) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: TEACHER,
      name: "Acc",
      allowed_accommodations: allowed,
      construct_altering: constructAltering,
      assigned_scope: assignedScope,
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: TEACHER, ssid: "WA-ACC", name: "Acc Student" })
    .returning();
  return { assessment: assessment as AssessmentRow, student: student! };
}

async function grant(
  studentId: string,
  toolId: string,
  value: string,
  opts: { subject?: string; removed?: boolean } = {},
) {
  await getDb()
    .insert(student_accommodations)
    .values({
      student_id: studentId,
      subject: opts.subject ?? "ELA-CAT",
      tool_id: toolId,
      value,
      source: "tide_import",
      removed_at: opts.removed ? new Date() : null,
    });
}

async function override(assessmentId: string, studentId: string, toolId: string, value: string) {
  await getDb().insert(assessment_student_overrides).values({
    assessment_id: assessmentId,
    student_id: studentId,
    tool_id: toolId,
    value,
    created_by_sub: TEACHER,
  });
}

describe("isEnabledValue", () => {
  // TIDE records a setting for every tool, so "has a row" does not mean "gets
  // the tool" — most rows say Off.
  test("treats the TIDE off-ish values as not enabled", () => {
    for (const value of ["Off", "off", "  OFF  ", "None (Default)", "none", ""]) {
      expect(isEnabledValue(value)).toBe(false);
    }
  });

  test("treats any real setting as enabled, whatever it says", () => {
    for (const value of ["On", "Stimuli+Items", "Black on Rose", "OpenDyslexic"]) {
      expect(isEnabledValue(value)).toBe(true);
    }
  });
});

describe("resolveEffectiveAccommodations", () => {
  test("returns the student's entitlements that the assessment permits", async () => {
    const { assessment, student } = await seed(["spell_check", "highlighter"]);
    await grant(student.id, "spell_check", "On");
    await grant(student.id, "highlighter", "On");

    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({ spell_check: "On", highlighter: "On" });
  });

  // The value is the payload, not just a flag: a client told only that
  // color_contrast is on still does not know which contrast to render.
  test("carries the setting value through, not merely that it is on", async () => {
    const { assessment, student } = await seed(["color_contrast"]);
    await grant(student.id, "color_contrast", "Black on Rose");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled.color_contrast).toBe("Black on Rose");
  });

  // The construct-validity gate. Read-aloud on a reading test measures
  // something other than reading, so an assessment may forbid it for everyone.
  test("drops an entitlement the assessment does not permit", async () => {
    const { assessment, student } = await seed(["spell_check"]);
    await grant(student.id, "spell_check", "On");
    await grant(student.id, "tts_test_content", "On");

    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({ spell_check: "On" });
  });

  test("an Off entitlement is not an entitlement", async () => {
    const { assessment, student } = await seed(["highlighter"]);
    await grant(student.id, "highlighter", "Off");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({});
  });

  // removed_at is a soft delete kept for the audit trail. A withdrawn
  // accommodation must stop being applied.
  test("a soft-removed row no longer grants anything", async () => {
    const { assessment, student } = await seed(["spell_check"]);
    await grant(student.id, "spell_check", "On", { removed: true });
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({});
  });

  // An assessment has no subject field to filter by, so entitlements are
  // unioned across subjects and the assessment's allowed list does the
  // narrowing — which is the narrowing a teacher actually reasons about.
  test("unions entitlements across TIDE subjects", async () => {
    const { assessment, student } = await seed(["spell_check", "color_contrast"]);
    await grant(student.id, "spell_check", "On", { subject: "Mathematics" });
    await grant(student.id, "color_contrast", "Black on White", { subject: "Science" });

    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(Object.keys(result.enabled).sort()).toEqual(["color_contrast", "spell_check"]);
  });

  test("an override sets the value for this assessment", async () => {
    const { assessment, student } = await seed(["color_contrast"]);
    await grant(student.id, "color_contrast", "Black on White");
    await override(assessment.id, student.id, "color_contrast", "Black on Rose");

    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled.color_contrast).toBe("Black on Rose");
  });

  test("an override can grant a permitted tool the student has no row for", async () => {
    const { assessment, student } = await seed(["highlighter"]);
    await override(assessment.id, student.id, "highlighter", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({ highlighter: "On" });
  });

  // The whole point of a per-assessment override.
  test("an override set to Off revokes a standing entitlement", async () => {
    const { assessment, student } = await seed(["spell_check"]);
    await grant(student.id, "spell_check", "On");
    await override(assessment.id, student.id, "spell_check", "Off");

    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({});
  });

  // Slice 63: on the teacher's OWN assessment the override wins. They own the
  // construct decision and they know this child; making them widen the
  // assessment-wide list to help one student would push them to widen it for
  // everyone.
  test("on a teacher-assigned assessment, an override outranks the allowed list", async () => {
    const { assessment, student } = await seed(["spell_check"]);
    await override(assessment.id, student.id, "tts_test_content", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({ tts_test_content: "On" });
  });

  // Nobody vetted that tool against this assessment's construct, so the score
  // carries the flag rather than being assumed unaffected.
  test("a tool granted beyond the allowed list is flagged construct-altering", async () => {
    const { assessment, student } = await seed(["spell_check"]);
    await override(assessment.id, student.id, "tts_test_content", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.constructAltering).toEqual(["tts_test_content"]);
  });

  test("a tool granted WITHIN the allowed list is not flagged by that alone", async () => {
    const { assessment, student } = await seed(["highlighter"]);
    await override(assessment.id, student.id, "highlighter", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({ highlighter: "On" });
    expect(result.constructAltering).toEqual([]);
  });

  // The construct decision was made above the teacher, and a per-student
  // override crossing it silently would invalidate a score the school or
  // district is going to compare across classrooms.
  for (const scope of ["school", "district"] as const) {
    test(`on a ${scope}-assigned assessment, an override cannot exceed the allowed list`, async () => {
      const { assessment, student } = await seed(["spell_check"], [], scope);
      await override(assessment.id, student.id, "tts_test_content", "On");
      const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
      expect(result.enabled).toEqual({});
    });

    test(`on a ${scope}-assigned assessment, an override still sets a permitted tool`, async () => {
      const { assessment, student } = await seed(["color_contrast"], [], scope);
      await override(assessment.id, student.id, "color_contrast", "Black on Rose");
      const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
      expect(result.enabled).toEqual({ color_contrast: "Black on Rose" });
    });

    test(`on a ${scope}-assigned assessment, an Off override still revokes`, async () => {
      // Withdrawing a support for one student never threatens comparability,
      // and the teacher is always the person closest to the child.
      const { assessment, student } = await seed(["spell_check"], [], scope);
      await grant(student.id, "spell_check", "On");
      await override(assessment.id, student.id, "spell_check", "Off");
      const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
      expect(result.enabled).toEqual({});
    });
  }

  test("an override naming a tool outside the catalog is dropped whatever the scope", async () => {
    // A shape check, not a policy one: no client can honour an unknown id.
    const { assessment, student } = await seed(["spell_check"]);
    await override(assessment.id, student.id, "not_a_real_tool", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({});
  });

  test("assessments default to teacher scope", async () => {
    const { assessment } = await seed(["spell_check"]);
    expect(assessment.assigned_scope).toBe("teacher");
  });

  test("flags the enabled tools the assessment calls construct-altering", async () => {
    const { assessment, student } = await seed(
      ["spell_check", "highlighter"],
      ["spell_check"],
    );
    await grant(student.id, "spell_check", "On");
    await grant(student.id, "highlighter", "On");

    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.constructAltering).toEqual(["spell_check"]);
  });

  test("does not flag a construct-altering tool the student did not get", async () => {
    const { assessment, student } = await seed(["spell_check"], ["spell_check"]);
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({});
    expect(result.constructAltering).toEqual([]);
  });

  test("an assessment permitting nothing resolves to nothing", async () => {
    const { assessment, student } = await seed([]);
    await grant(student.id, "spell_check", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({});
  });

  // An id that is not in the 55-entry catalog cannot be honoured by any client,
  // so it is filtered rather than passed along as noise.
  test("ignores an allowed id that is not in the catalog", async () => {
    const { assessment, student } = await seed(["spell_check", "not_a_real_tool"]);
    await grant(student.id, "not_a_real_tool", "On");
    await grant(student.id, "spell_check", "On");
    const result = await resolveEffectiveAccommodations(getDb(), assessment, student.id);
    expect(result.enabled).toEqual({ spell_check: "On" });
  });
});
