// The help page's demo roster (lib/dev/demoRoster.ts): a valid extract by the
// same contract the nightly import uses, fictional by construction, and only
// ever written to a `_demo` database. No database needed.
import { describe, expect, test } from "bun:test";
import { validateExtract } from "../lib/roster/extract";
import { MANIFEST_NAME } from "../lib/roster/syncHandler";
import {
  buildDemoExtract,
  DEMO_CO_TEACHER_EMAIL,
  DEMO_SECTIONS,
  DEMO_TEACHER,
  demoStudents,
  isDemoDatabaseUrl,
  isStagingDatabaseUrl,
  parseStagingArgs,
} from "../lib/dev/demoRoster";

async function validate(now: Date) {
  const { files } = buildDemoExtract(now);
  const manifest = JSON.parse(new TextDecoder().decode(files.get(MANIFEST_NAME)!));
  return validateExtract(manifest, async (path) => files.get(path) ?? null);
}

describe("buildDemoExtract", () => {
  test("passes the extract contract with every row", async () => {
    const result = await validate(new Date("2026-09-25T12:00:00Z"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.students.length).toBe(30);
    expect(result.snapshot.sections.length).toBe(DEMO_SECTIONS.length);
    expect(result.snapshot.section_teachers.length).toBe(4);
    const enrolled = demoStudents().reduce((n, s) => n + s.sections.length, 0);
    expect(result.snapshot.enrollments.length).toBe(enrolled);
  });

  test("assignments cover the whole school year the date falls in", async () => {
    for (const [now, end] of [
      ["2026-09-25T12:00:00Z", "2027-06-30"],
      ["2027-03-01T12:00:00Z", "2027-06-30"],
    ] as const) {
      const result = await validate(new Date(now));
      if (!result.ok) throw new Error(result.reason);
      for (const t of result.snapshot.section_teachers) expect(String(t.end_date)).toContain(end);
    }
  });

  test("only the two demo teachers teach, and every student uses the student domain", () => {
    const { files } = buildDemoExtract(new Date("2026-09-25T12:00:00Z"));
    const teachers = new TextDecoder().decode(files.get("section_teachers.csv")!);
    const emails = new Set(teachers.trim().split("\n").slice(1).map((r) => r.split(",")[2]));
    expect([...emails].sort()).toEqual([DEMO_CO_TEACHER_EMAIL, DEMO_TEACHER.email].sort());
    for (const s of demoStudents()) expect(s.email.endsWith("@edtools.psd401.net")).toBe(true);
  });

  test("carries no real-shaped student number or SSID (7- or 9-digit runs)", () => {
    const { files } = buildDemoExtract(new Date("2026-09-25T12:00:00Z"));
    for (const [path, bytes] of files) {
      if (path === MANIFEST_NAME) continue;
      const text = new TextDecoder().decode(bytes).replace(/\d{4}-\d{2}-\d{2}/g, "");
      const runs = [...text.matchAll(/\b\d+\b/g)].map((m) => m[0]);
      expect(runs.filter((r) => r.length === 7 || r.length === 9)).toEqual([]);
    }
  });
});

describe("isDemoDatabaseUrl", () => {
  test("accepts only a database name ending in _demo", () => {
    expect(isDemoDatabaseUrl("postgres://me@localhost:5432/secure_test_design_tool_demo")).toBe(true);
    expect(isDemoDatabaseUrl("postgres://me@localhost:5432/secure_test_design_tool_dev")).toBe(false);
    expect(isDemoDatabaseUrl("postgres://me@localhost:5432/demo_db")).toBe(false);
    expect(isDemoDatabaseUrl("not a url")).toBe(false);
    expect(isDemoDatabaseUrl(undefined)).toBe(false);
  });
});

// Renderer slice 2 (D-7): the staging stack's seed adds real accounts at run
// time. Placeholder values only — no real address or number in a test.
describe("staging extras", () => {
  const extras = {
    teachers: ["Staff.Example@psd401.net"],
    students: [{ email: "demo.a@edtools.psd401.net", ps_id: "123" }],
  };

  test("the extract still passes the contract, with the extra teacher on every section", async () => {
    const { files } = buildDemoExtract(new Date("2026-09-25T12:00:00Z"), extras);
    const manifest = JSON.parse(new TextDecoder().decode(files.get(MANIFEST_NAME)!));
    const result = await validateExtract(manifest, async (path) => files.get(path) ?? null);
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.students.length).toBe(31);
    const extraTeacherRows = result.snapshot.section_teachers.filter(
      (t) => String(t.teacher_email) === "staff.example@psd401.net",
    );
    expect(extraTeacherRows.length).toBe(DEMO_SECTIONS.length);
    const enrolled = result.snapshot.enrollments.filter((e) => String(e.student_ps_id) === "123");
    expect(enrolled.map((e) => String(e.section_ps_id))).toEqual([DEMO_SECTIONS[0].ps_id]);
  });

  test("the extra student keeps a fictional name", () => {
    const { files } = buildDemoExtract(new Date("2026-09-25T12:00:00Z"), extras);
    const students = new TextDecoder().decode(files.get("students.csv")!);
    const row = students.split("\n").find((r) => r.startsWith("123,"))!;
    expect(row).toContain(",Staging,Student A,");
  });

  test("no extras = the plain demo roster", () => {
    const a = buildDemoExtract(new Date("2026-09-25T12:00:00Z"));
    const b = buildDemoExtract(new Date("2026-09-25T12:00:00Z"), {});
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [k, v] of a.files) expect(new TextDecoder().decode(b.files.get(k)!)).toBe(new TextDecoder().decode(v));
  });
});

describe("parseStagingArgs", () => {
  test("accepts repeatable --teacher and --student", () => {
    expect(
      parseStagingArgs([
        "--teacher", "A@psd401.net",
        "--student", "S1@edtools.psd401.net=42",
        "--student", "s2@edtools.psd401.net=43",
      ]),
    ).toEqual({
      teachers: ["a@psd401.net"],
      students: [
        { email: "s1@edtools.psd401.net", ps_id: "42" },
        { email: "s2@edtools.psd401.net", ps_id: "43" },
      ],
    });
  });

  test("refuses the wrong domain, a missing number, a stray flag", () => {
    for (const argv of [
      ["--teacher", "a@edtools.psd401.net"],
      ["--teacher", "a@example.com"],
      ["--student", "s@psd401.net=42"],
      ["--student", "s@edtools.psd401.net"],
      ["--student", "s@edtools.psd401.net=4x"],
      ["--teacher"],
      ["--admin", "a@psd401.net"],
    ]) {
      expect("error" in parseStagingArgs(argv)).toBe(true);
    }
  });
});

describe("isStagingDatabaseUrl", () => {
  test("accepts only a database name ending in _staging", () => {
    expect(isStagingDatabaseUrl("postgres://u:p@host:5432/secure_test_design_tool_staging?sslmode=require")).toBe(true);
    expect(isStagingDatabaseUrl("postgres://u:p@host:5432/secure_test_design_tool?sslmode=require")).toBe(false);
    expect(isStagingDatabaseUrl("postgres://u:p@host:5432/secure_test_design_tool_demo")).toBe(false);
    expect(isStagingDatabaseUrl(undefined)).toBe(false);
  });
});
