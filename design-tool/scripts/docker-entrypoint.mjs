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
// Second mode (infra slice, 2026-09-01): `migrate` as the first argument
// runs the bundled db/migrate.ts (db/migrate.mjs, built in the Dockerfile)
// instead of the server and exits — a one-off ECS run-task on the service's
// task definition is how Aurora is migrated now that the cluster SG has no
// laptop CIDR (infra/README.md "Migrating Aurora",
// infra/scripts/migrate-aurora.sh). Any other argument is refused rather
// than silently booting a stray web server with no load balancer in front.

const mode = process.argv[2];
if (mode !== undefined && mode !== "migrate") {
  console.error(
    `docker-entrypoint: unknown mode "${mode}" — no argument boots the server, "migrate" runs migrations.`,
  );
  process.exit(64);
}

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
  new URL(mode === "migrate" ? "../db/migrate.mjs" : "../server.js", import.meta.url).href,
);
