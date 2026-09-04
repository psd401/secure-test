// Slice 78: the roster scene the student-plane tests share.
//
// Loads the fictional warehouse fixture (test/fixtures/roster/complete) through
// the real importer, and names the people in it that tests refer to. Nothing
// here is a real person.
//
//   teacher.one@psd401.net   teaches 5001 (Algebra 1) and 5003 (English 9)
//   teacher.two@psd401.net   teaches 5002 (Biology)
//   teacher.four@psd401.net  teaches 5004 (Grade 5 Homeroom)
//   1001 ada.fixture         in 5001 and 5003        ssid WA-FIX-1001
//   1002 ben.sample          in 5001                 ssid WA-FIX-1002
//   1003 cy.example          in 5002                 ssid WA-FIX-1003
//   1004 dee.placeholder     in 5001, left 2021      ssid WA-FIX-1004
//   1005 eli.noemail         in 5004, NO ssid
//   1006 (no email)          in 5004
//   1007 gus.transferred     in 5001, left 2021, enroll_status 2
import { sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { importSnapshot } from "../../lib/roster/importSnapshot";
import type { SessionPayload } from "../../lib/auth/session";
import { loadExtract } from "../fixtures/roster/load";

export const TEACHER_EMAIL = "teacher.one@psd401.net";
export const OTHER_TEACHER_EMAIL = "teacher.two@psd401.net";

export const STUDENT = {
  ps_id: "1001",
  ssid: "WA-FIX-1001",
  email: "ada.fixture@edtools.psd401.net",
  name: "Ada Fixture",
} as const;

export const OTHER_STUDENT = {
  ps_id: "1002",
  ssid: "WA-FIX-1002",
  email: "ben.sample@edtools.psd401.net",
  name: "Ben Sample",
} as const;

/** Enrolled only in teacher.two's section. */
export const BIOLOGY_STUDENT = {
  ps_id: "1003",
  ssid: "WA-FIX-1003",
  email: "cy.example@edtools.psd401.net",
} as const;

/** Was in 5001; enrollment ended 2021-10-01. */
export const LEFT_STUDENT = {
  ps_id: "1004",
  ssid: "WA-FIX-1004",
  email: "dee.placeholder@edtools.psd401.net",
} as const;

/** On the roster with no SSID yet — the state before the data engineer's column lands. */
export const NO_SSID_STUDENT = {
  ps_id: "1005",
  email: "eli.noemail@edtools.psd401.net",
  teacherEmail: "teacher.four@psd401.net",
} as const;

export async function seedRoster(): Promise<void> {
  const ex = await loadExtract();
  const result = await importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
  if (!result.ok) throw new Error(`roster fixture refused: ${result.reason}`);
}

export async function clearRoster(): Promise<void> {
  await getDb().execute(
    sql`truncate table roster_enrollments, roster_section_teachers, roster_sections, roster_students, roster_sync_runs`,
  );
}

export type TestPrincipal = SessionPayload & { role: string };

export function studentPrincipal(email: string = STUDENT.email): TestPrincipal {
  return { sub: `google-${email}`, role: "student", email };
}

export function staffPrincipal(sub: string, email: string = TEACHER_EMAIL): TestPrincipal {
  return { sub, role: "staff", email };
}
