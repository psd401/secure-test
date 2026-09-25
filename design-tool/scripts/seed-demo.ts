// Dev-only: load the fictional demo roster (lib/dev/demoRoster.ts) into a
// database whose name ends in `_demo`, for the help page's screenshots.
// docs/help-capture.md is the full recipe.
//
//   createdb secure_test_design_tool_demo
//   DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_demo bun db/migrate.ts
//   DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_demo \
//     bun --env-file=.env.local scripts/seed-demo.ts
//
// (DATABASE_URL on the command line wins over .env.local — Bun does not
// override a variable that is already set.)
//
// Re-running is safe: the importer upserts, and a new day's run keeps the
// assignments current. Prints the demo teacher's session cookie value when
// DESIGN_TOOL_SESSION_SECRET is set (8-hour lifetime), for signing a browser
// in as that teacher without Google.
import { closeDb, getDb } from "../db/client";
import { mintSessionJWT, SESSION_COOKIE_NAME } from "../lib/auth/session";
import { buildDemoExtract, DEMO_TEACHER, isDemoDatabaseUrl } from "../lib/dev/demoRoster";
import { MockSnapshotSource, runSync } from "../lib/roster/syncHandler";

if (process.env.NODE_ENV === "production") {
  console.error("seed-demo is a dev tool; refusing to run in production");
  process.exit(1);
}
if (!isDemoDatabaseUrl(process.env.DATABASE_URL)) {
  console.error("seed-demo only writes to a database whose name ends in _demo; set DATABASE_URL to one");
  process.exit(2);
}

const { snapshotId, files } = buildDemoExtract();
const result = await runSync(getDb(), new MockSnapshotSource().add(snapshotId, files), snapshotId);
await closeDb();
if (!result.ok) process.exit(1);

if (process.env.DESIGN_TOOL_SESSION_SECRET) {
  const token = await mintSessionJWT({
    sub: DEMO_TEACHER.sub,
    role: "staff",
    email: DEMO_TEACHER.email,
    hd: "psd401.net",
  });
  console.log(`${SESSION_COOKIE_NAME}=${token}`);
}
