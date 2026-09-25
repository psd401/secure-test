import { sha256Hex } from "@/lib/roster/extract";
import { MANIFEST_NAME } from "@/lib/roster/syncHandler";

// A made-up class list for the help page's screenshots (docs/help-capture.md).
//
// Every person here is fictional and lives only in a database whose name ends
// in `_demo` (scripts/seed-demo.ts refuses anything else), so no screenshot can
// pick up a real roster row or one of the real demo accounts in the dev DB.
// The extract goes through the real importer, exactly like the nightly one.

export const DEMO_TEACHER = {
  sub: "demo-teacher",
  email: "demo.teacher@psd401.net",
} as const;

export const DEMO_CO_TEACHER_EMAIL = "demo.coteacher@psd401.net";

const SCHOOL_ID = "900";

/** Three sections for the demo teacher; the co-teacher shares the last one. */
export const DEMO_SECTIONS = [
  { ps_id: "6101", course_code: "SCI310", course_name: "AP Biology", period: "1(A)" },
  { ps_id: "6102", course_code: "SCI210", course_name: "Biology", period: "3(A)" },
  { ps_id: "6103", course_code: "ENG210", course_name: "English 10", period: "5(A)" },
] as const;

const FIRST = [
  "Avery", "Jordan", "Mateo", "Priya", "Liam", "Sofia", "Noah", "Amara",
  "Ethan", "Hana", "Lucas", "Maya", "Owen", "Zara", "Caleb", "Isla",
  "Diego", "Nora", "Elias", "Leah", "Kai", "Ruby", "Theo", "Mira",
  "Felix", "Ivy", "Rowan", "Lena", "Silas", "Tessa",
] as const;

const LAST = [
  "Brooks", "Castillo", "Dunn", "Ellison", "Farrow", "Garza", "Holt", "Iverson",
  "Jensen", "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Pruitt", "Quinlan",
  "Rasmussen", "Sato", "Thorne", "Underwood", "Vance", "Whitaker", "Yilmaz", "Zeller",
  "Abernathy", "Bellweather", "Crane", "Delacroix", "Easton", "Fairbanks",
] as const;

export type DemoStudent = {
  ps_id: string;
  ssid: string;
  email: string;
  first_name: string;
  last_name: string;
  grade: string;
  sections: string[];
};

/** 30 students: 1–12 in AP Biology, 11–22 in Biology, 21–30 in English 10
 * (a few sit in two sections, as real students do). */
export function demoStudents(): DemoStudent[] {
  return FIRST.map((first, i) => {
    const n = i + 1;
    const last = LAST[i]!;
    const sections: string[] = [];
    if (n <= 12) sections.push(DEMO_SECTIONS[0].ps_id);
    if (n >= 11 && n <= 22) sections.push(DEMO_SECTIONS[1].ps_id);
    if (n >= 21) sections.push(DEMO_SECTIONS[2].ps_id);
    const ps_id = String(7000 + n);
    return {
      ps_id,
      ssid: `WA-DEMO-${ps_id}`,
      email: `${first}.${last}`.toLowerCase() + "@edtools.psd401.net",
      first_name: first,
      last_name: last,
      grade: n <= 12 ? "11" : "10",
      sections,
    };
  });
}

function csv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join(",")).join("\n") + "\n";
}

/**
 * The four CSVs plus manifest.json as path → bytes, ready for
 * `MockSnapshotSource.add`. Assignments run from `start` to the next
 * June 30 after it, so the roster stays current all school year.
 */
export function buildDemoExtract(now: Date = new Date()): {
  snapshotId: string;
  files: Map<string, Uint8Array>;
} {
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const start = `${year - 1}-08-25`;
  const end = `${year}-06-30`;
  const students = demoStudents();

  const tables: Record<string, string> = {
    students: csv(
      ["ps_id", "ssid", "email", "first_name", "last_name", "grade", "school_id", "enroll_status"],
      students.map((s) => [s.ps_id, s.ssid, s.email, s.first_name, s.last_name, s.grade, SCHOOL_ID, "0"]),
    ),
    sections: csv(
      ["ps_id", "school_id", "course_code", "course_name", "term_id", "period_expression"],
      DEMO_SECTIONS.map((s) => [s.ps_id, SCHOOL_ID, s.course_code, s.course_name, "3600", s.period]),
    ),
    section_teachers: csv(
      ["section_ps_id", "teacher_ps_id", "teacher_email", "role_name", "priority_order", "start_date", "end_date"],
      [
        ...DEMO_SECTIONS.map((s) => [s.ps_id, "401", DEMO_TEACHER.email, "Lead Teacher", "1", start, end]),
        [DEMO_SECTIONS[2].ps_id, "402", DEMO_CO_TEACHER_EMAIL, "Co-teacher", "2", start, end],
      ],
    ),
    enrollments: csv(
      ["ps_id", "student_ps_id", "section_ps_id", "dateenrolled", "dateleft"],
      students.flatMap((s) =>
        s.sections.map((sec) => [`${s.ps_id}${sec.slice(-1)}`, s.ps_id, sec, start, end]),
      ),
    ),
  };

  const snapshotId = `demo-${now.toISOString().slice(0, 10).replaceAll("-", "")}`;
  const files = new Map<string, Uint8Array>();
  const manifestFiles: Record<string, { path: string; rows: number; sha256: string }> = {};
  for (const [table, text] of Object.entries(tables)) {
    const bytes = new TextEncoder().encode(text);
    const path = `${table}.csv`;
    files.set(path, bytes);
    manifestFiles[table] = { path, rows: text.trim().split("\n").length - 1, sha256: sha256Hex(bytes) };
  }
  const manifest = {
    format_version: 1,
    snapshot_id: snapshotId,
    generated_at: now.toISOString(),
    source: "secure-test demo roster (fictional)",
    files: manifestFiles,
  };
  files.set(MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  return { snapshotId, files };
}

/** The seed only ever writes to a database whose name ends in `_demo`. */
export function isDemoDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /_demo$/.test(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}
