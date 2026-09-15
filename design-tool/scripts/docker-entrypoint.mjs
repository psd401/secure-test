// Container boot shim (ECS deploy slice 3, docs/ecs-deploy-plan.md).
//
// Assembles DATABASE_URL at boot from the Aurora credentials secret, then
// hands off to the Next standalone server. Same URL shape as the roster
// importer's databaseUrlFromSecret (lib/roster/syncHandler.ts:275) —
// encodeURIComponent on user/password, sslmode=require.
//
// The secret's JSON keys arrive as individual DB_* env vars via ECS-native
// secret injection (infra/lib/app-service.ts maps them with
// ecs.Secret.fromSecretsManager(secret, key)) rather than an SDK
// GetSecretValue call here: the standalone file trace doesn't carry
// @aws-sdk/client-secrets-manager, the read grant lands on the ECS
// execution role where ECS expects it, and there is no boot-time API call
// to retry. A pre-set DATABASE_URL (local docker runs) wins untouched.
//
// One-off modes (infra slice, 2026-09-01; extended by slice 4 of
// docs/scoring-corpus-design.md, 2026-09-14): a first argument names a
// bundled operator script to run INSTEAD of the server, then exits. Each is
// bundled by `bun build` in the Dockerfile's builder stage because the
// runtime image has no bun and the standalone trace does not carry
// drizzle-orm/postgres as resolvable modules.
//
//   migrate       → db/migrate.mjs     (infra/README.md "Migrating Aurora")
//   corpus        → score-corpus.mjs   (README "Corpus runs on Aurora")
//   compare       → compare-runs.mjs
//   seed-essays   → seed-essays.mjs    (README "Seeding pilot essays")
//   roster-health → roster-health.mjs
//
// A one-off ECS run-task on the service's own task definition is how any of
// these reaches Aurora now that the cluster SG has no laptop CIDR
// (infra/scripts/oneoff-aurora.sh; migrate-aurora.sh wraps it). Any other
// argument is refused rather than silently booting a stray web server with
// no load balancer in front.
//
// Everything after the mode is the script's own argv: process.argv is
// spliced so the mode disappears and each script's `process.argv.slice(2)`
// sees exactly the pass-through arguments. The scripts are unchanged and
// still run byte-identically under bun locally.

const MODES = {
  migrate: "../db/migrate.mjs",
  corpus: "./score-corpus.mjs",
  compare: "./compare-runs.mjs",
  // Pilot essay seeding (docs/scoring-corpus-design.md §Progress,
  // 2026-09-15). Unlike seed-attempts this one is MEANT to run against the
  // deployed database: every student is named explicitly on the command
  // line, so nothing is discovered and nothing is fabricated in bulk.
  "seed-essays": "./seed-essays.mjs",
  // Roster health, the SQL from the go-live checklist. Read-only, and the
  // only way to run it against Aurora now that the cluster SG has no laptop
  // CIDR.
  "roster-health": "./roster-health.mjs",
};

const mode = process.argv[2];
if (mode !== undefined && !Object.hasOwn(MODES, mode)) {
  console.error(
    `docker-entrypoint: unknown mode "${mode}" — no argument boots the server; ` +
      `modes: ${Object.keys(MODES).join(", ")}.`,
  );
  process.exit(64);
}
// Drop the mode so the target script's process.argv.slice(2) is its own args.
if (mode !== undefined) process.argv.splice(2, 1);

if (!process.env.DATABASE_URL) {
  const missing = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    .filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `docker-entrypoint: no DATABASE_URL and missing ${missing.join(", ")} — ` +
        "set DATABASE_URL directly or inject the DB_* vars from the cluster secret.",
    );
    process.exit(64);
  }
  const user = encodeURIComponent(process.env.DB_USER);
  const pass = encodeURIComponent(process.env.DB_PASSWORD);
  const { DB_HOST, DB_PORT, DB_NAME } = process.env;
  process.env.DATABASE_URL = `postgres://${user}:${pass}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require`;
}

await import(
  new URL(mode === undefined ? "../server.js" : MODES[mode], import.meta.url).href,
);
