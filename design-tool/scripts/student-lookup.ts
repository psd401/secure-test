// Why can't this student get in? (roadmap U-11's operator half, 2026-09-30)
//
//   DATABASE_URL=postgres://… bun scripts/student-lookup.ts <email | student-number>
//   infra/scripts/oneoff-aurora.sh student-lookup <email | student-number>
//
// Read-only. Runs lib/roster/lookup.ts — the join routes' own rules — and
// prints the verdict, the student's enrollments with each section's teachers,
// and the open sittings that admit the student or belong to one of those
// teachers. Prints no student name and no stored address (the one-off task's
// stdout lands in CloudWatch).
//
// Exit code: 0 when the verdict is ok, 1 otherwise, 2 on a bad argument.
import { closeDb, getDb } from "../db/client";
import { lookupStudent } from "../lib/roster/lookup";

const arg = process.argv[2]?.trim();
if (!arg) {
  console.error("usage: student-lookup <email | student-number>");
  process.exit(2);
}
const query = arg.includes("@") ? { email: arg } : { psId: arg };
if (!arg.includes("@") && !/^\d+$/.test(arg)) {
  console.error("student-lookup: expected an email address or a numeric student number");
  process.exit(2);
}

const r = await lookupStudent(getDb(), query);
await closeDb();

const yn = (b: boolean) => (b ? "yes" : "NO");
console.log(`── student lookup (as of ${r.as_of}, UTC — the app's date rules)`);
console.log(`verdict: ${r.verdict}   (active rows with this address: ${r.active_rows_with_email})`);
console.log(
  `email_ref: ${r.email_ref ?? "(none)"}   — match against student_resolution_failed lines in CloudWatch`,
);
if (r.students.length === 0) console.log("no roster row matches");
for (const s of r.students) {
  const match = s.email_matches_query === undefined ? "" : `  stored = asked: ${yn(s.email_matches_query)}`;
  console.log(
    `student ${s.ps_id}  active: ${yn(s.is_active)}  enroll_status: ${s.enroll_status}  ` +
      `email: ${s.email_domain ?? "NONE"} (student shape: ${yn(s.email_is_student_shape)})${match}`,
  );
}
if (r.enrollments.length) console.log("── enrollments");
for (const e of r.enrollments) {
  console.log(
    `${e.section_ps_id.padEnd(8)} ${e.course_name.padEnd(28)} ${e.period.padEnd(6)} ` +
      `${e.dateenrolled}→${e.dateleft}  current: ${yn(e.enrollment_current)}  section active: ${yn(e.section_active)}`,
  );
  for (const t of e.teachers) {
    console.log(`         teacher ${t.email ?? "(no email)"} ${t.role ? `[${t.role}] ` : ""}current: ${yn(t.current)}`);
  }
}
console.log(`── open sittings (admitting the student, or owned by one of these teachers): ${r.sittings.length}`);
for (const s of r.sittings) {
  console.log(
    `${s.code}  owner ${s.owner_email ?? "(none)"}  scope ${s.scope}${s.section_ps_id ? ` ${s.section_ps_id}` : ""}  admitted: ${yn(s.admitted)}`,
  );
}

process.exit(r.verdict === "ok" ? 0 : 1);
