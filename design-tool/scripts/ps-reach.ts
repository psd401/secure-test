// Read-only reachability check of the PRODUCTION PowerSchool plugin from
// inside the VPC (docs/gradebook-push-design.md). Run through
// `infra/scripts/oneoff-aurora.sh ps-reach [teacher@psd401.net]` — same task
// definition, same network path and same ECS-injected POWERSCHOOL_* values as
// the app service, so a pass here means a Send from the app can reach
// PowerSchool.
//
// Uses the live client directly (not getPowerSchoolClient), so it works
// whether or not GRADEBOOK_PROVIDER=live is set yet. Two calls:
//   1. the OAuth token (proves DNS, TLS, the base URL and the credentials);
//   2. one teacher's category list for a school year (proves the plugin's
//      gradebook read access) — the teacher is the one named, or else any
//      roster teacher with a users_dcid on a section with a year_id.
//
// Writes nothing. Prints statuses and counts only — never the base URL,
// tokens, credentials, emails or ids.
//
// Exit code: 0 pass, 1 PowerSchool refused or was unreachable, 2 setup
// (missing env, no roster row to try).
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { GradebookHttpError, createLivePowerSchoolClient } from "../lib/gradebook/powerschool";

const teacherEmail = process.argv[2]?.trim().toLowerCase();

const baseUrl = process.env.POWERSCHOOL_BASE_URL ?? "";
const clientId = process.env.POWERSCHOOL_CLIENT_ID ?? "";
const clientSecret = process.env.POWERSCHOOL_CLIENT_SECRET ?? "";
console.log(
  `env: base url ${baseUrl ? "set" : "MISSING"}, client id ${clientId ? "set" : "MISSING"}, ` +
    `client secret ${clientSecret ? "set" : "MISSING"}; GRADEBOOK_PROVIDER=${process.env.GRADEBOOK_PROVIDER ?? "(unset)"}`,
);
if (!baseUrl || !clientId || !clientSecret) {
  process.exitCode = 2;
} else {
  const rows = (await getDb().execute(sql`
    select t.users_dcid, s.year_id
    from roster_section_teachers t
    join roster_sections s on s.ps_id = t.section_ps_id
    where t.users_dcid is not null and s.year_id is not null
      ${teacherEmail ? sql`and t.teacher_email = ${teacherEmail}` : sql``}
    order by s.year_id desc, t.end_date desc
    limit 1
  `)) as unknown as Array<{ users_dcid: string; year_id: string }>;
  const row = rows[0];
  if (!row) {
    console.log(`roster: no teacher row with a users_dcid and year_id${teacherEmail ? " for that email" : ""}`);
    process.exitCode = 2;
  } else {
    console.log(`roster: using ${teacherEmail ? "the named teacher" : "a roster teacher"} (ids not printed)`);
    const client = createLivePowerSchoolClient({ baseUrl, clientId, clientSecret });
    const started = Date.now();
    try {
      const categories = await client.listCategories(row.users_dcid, row.year_id);
      console.log(`token: ok`);
      console.log(`categories: ${categories.length} read in ${Date.now() - started} ms`);
      console.log("ps-reach: PASS");
    } catch (err) {
      if (err instanceof GradebookHttpError) {
        console.log(`ps-reach: FAIL at ${err.stage} — HTTP ${err.status}`);
      } else {
        const e = err as { name?: string; message?: string; cause?: { code?: string } };
        console.log(
          `ps-reach: FAIL — ${e.name ?? "Error"}${e.cause?.code ? ` (${e.cause.code})` : ""}: ${String(e.message ?? err).slice(0, 200)}`,
        );
      }
      process.exitCode = 1;
    }
  }
}
await closeDb();
