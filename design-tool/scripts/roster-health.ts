// Roster health in one command — the SQL from
// docs/sep-2-roster-go-live-checklist.md, promoted to a script now that
// running it is routine (checklist §Notes named this the candidate slice).
//
//   DATABASE_URL=postgres://… bun scripts/roster-health.ts [teacher@psd401.net]
//
// Prints: the last 5 sync runs, table counts, and the "current" counts the
// app's date rules see (enrollmentIsCurrent / teacherAssignmentIsCurrent —
// NOTE: current_date is Postgres-side UTC, so the Sep-2 flip reads live
// from 5 PM PT on Sep 1). With a teacher email, also resolves that
// teacher's roster through the same joins the app uses.
//
// Exit code: 1 if the latest sync run did not succeed, else 0 — cron- and
// checklist-friendly.
import { closeDb, getDb } from "../db/client";
import { sql } from "drizzle-orm";

const teacherEmail = process.argv[2]?.toLowerCase();
const db = getDb();

const runs = (await db.execute(sql`
  select snapshot_id, status, coalesce(reason, '') as reason,
         started_at, finished_at
  from roster_sync_runs order by started_at desc limit 5
`)) as unknown as Array<{
  snapshot_id: string;
  status: string;
  reason: string;
  started_at: unknown;
}>;

console.log("── last 5 sync runs");
for (const r of runs) {
  console.log(
    `${r.snapshot_id}  ${r.status}${r.reason ? ` (${r.reason})` : ""}  ${String(r.started_at)}`,
  );
}

const counts = (await db.execute(sql`
  select
    (select count(*) from roster_students) as students,
    (select count(*) from roster_students where ssid is not null) as ssid_filled,
    (select count(*) from roster_sections where is_active) as sections,
    (select count(*) from roster_section_teachers where is_active) as teacher_rows,
    (select count(*) from roster_enrollments where is_active) as enrollments,
    (select count(*) from roster_enrollments
      where is_active and dateenrolled <= current_date
        and dateleft > current_date) as enrollments_current,
    (select count(*) from roster_section_teachers
      where is_active and start_date <= current_date
        and end_date >= current_date) as teacher_rows_current,
    current_date as db_today
`)) as unknown as Array<Record<string, unknown>>;

console.log("── counts");
for (const [k, v] of Object.entries(counts[0] ?? {})) {
  console.log(`${k.padEnd(22)} ${String(v)}`);
}

if (teacherEmail) {
  const roster = (await db.execute(sql`
    select s.ps_id, s.course_name, s.period_expression,
           count(distinct e.student_ps_id) as students
    from roster_section_teachers st
    join roster_sections s on s.ps_id = st.section_ps_id and s.is_active
    join roster_enrollments e on e.section_ps_id = s.ps_id
      and e.is_active and e.dateenrolled <= current_date
      and e.dateleft > current_date
    where st.is_active and st.start_date <= current_date
      and st.end_date >= current_date
      and st.teacher_email = ${teacherEmail}
    group by 1, 2, 3 order by 1
  `)) as unknown as Array<Record<string, unknown>>;
  console.log(`── roster for ${teacherEmail} (${roster.length} sections)`);
  for (const r of roster) {
    console.log(
      `${String(r.ps_id).padEnd(10)} ${String(r.course_name).padEnd(28)} ${String(r.period_expression).padEnd(8)} ${String(r.students)} students`,
    );
  }
}

await closeDb();

const latest = runs[0];
if (!latest || latest.status !== "succeeded") {
  console.error(`NOT HEALTHY: latest run ${latest ? `is ${latest.status}` : "missing"}`);
  process.exit(1);
}
