// STAGING only: load the fictional demo roster (lib/dev/demoRoster.ts) into
// the staging stack's database, plus the real accounts a rehearsal needs —
// renderer slice 2, D-7 (docs/server-delivered-renderer-design.md).
//
//   STACK=SecureTestDesignToolStaging design-tool/infra/scripts/oneoff-aurora.sh \
//     seed-staging --teacher <your staff email> \
//     --student <demo student email>=<student number> [--student …]
//
// The real addresses and student numbers are typed at run time and never go
// into a tracked file. Every name stays fictional.
//
// Two guards, both required, so this can never write to production:
//   - SECURE_TEST_DEPLOYMENT=staging, which only the staging stack's task
//     definition sets;
//   - a database whose name ends in `_staging` (the staging stack's default
//     database; production's is secure_test_design_tool).
//
// Re-run with the SAME flags: the importer treats each run as the whole
// roster, so a run without an account drops it.
import { closeDb, getDb } from "../db/client";
import { buildDemoExtract, isStagingDatabaseUrl, parseStagingArgs } from "../lib/dev/demoRoster";
import { MockSnapshotSource, runSync } from "../lib/roster/syncHandler";

if (process.env.SECURE_TEST_DEPLOYMENT !== "staging") {
  console.error("seed-staging runs only on the staging stack (SECURE_TEST_DEPLOYMENT=staging)");
  process.exit(1);
}
if (!isStagingDatabaseUrl(process.env.DATABASE_URL)) {
  console.error("seed-staging only writes to a database whose name ends in _staging");
  process.exit(2);
}
const extras = parseStagingArgs(process.argv.slice(2));
if ("error" in extras) {
  console.error(`seed-staging: ${extras.error}`);
  process.exit(64);
}

const { snapshotId, files } = buildDemoExtract(new Date(), extras);
const result = await runSync(getDb(), new MockSnapshotSource().add(snapshotId, files), snapshotId);
await closeDb();
console.log(
  `seed-staging: ${result.ok ? "ok" : "FAILED"} — snapshot ${snapshotId}, ` +
    `${extras.teachers?.length ?? 0} teacher(s), ${extras.students?.length ?? 0} demo student account(s) added`,
);
if (!result.ok) process.exit(1);
