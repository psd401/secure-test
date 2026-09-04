// Dev-only: fabricate submitted attempts + responses for an assessment so
// the Phase 3 scoring slices have data (docs/phase-3-slices.md, slice 35).
//
//   DATABASE_URL=postgres://<you>@localhost:5432/secure_test_design_tool_dev \
//     bun scripts/seed-attempts.ts <assessment-id> [count=5]
//
// With no assessment id, lists the assessments in the target DB and exits.
import { desc } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import { seedAttempts } from "../lib/dev/seedAttempts";

if (process.env.NODE_ENV === "production") {
  console.error("seed-attempts is a dev tool; refusing to run in production");
  process.exit(1);
}

const [assessmentId, countArg] = process.argv.slice(2);
const db = getDb();

if (!assessmentId) {
  const rows = await db
    .select({ id: assessments.id, name: assessments.name })
    .from(assessments)
    .orderBy(desc(assessments.created_at));
  if (rows.length === 0) {
    console.error("no assessments in this DB — create one in the app first");
  } else {
    console.error("usage: bun scripts/seed-attempts.ts <assessment-id> [count]");
    console.error("assessments in this DB:");
    for (const r of rows) console.error(`  ${r.id}  ${r.name}`);
  }
  await closeDb();
  process.exit(1);
}

const count = countArg ? Number(countArg) : 5;
if (!Number.isInteger(count) || count < 1) {
  console.error(`count must be a positive integer; got "${countArg}"`);
  await closeDb();
  process.exit(1);
}

const result = await seedAttempts(db, { assessmentId, count });
console.log(
  `seeded ${result.attemptIds.length} attempts / ${result.responseCount} responses ` +
    `across ${result.studentIds.length} students for assessment ${assessmentId}`,
);
await closeDb();
