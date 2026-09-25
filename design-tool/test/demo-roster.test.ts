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
