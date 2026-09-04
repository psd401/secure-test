import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Runs two ways (infra/README.md "Migrating Aurora"):
//   - `bun run db:migrate` from design-tool/, against DATABASE_URL (local dev
//     and the test database);
//   - bundled by `bun build` into db/migrate.mjs inside the Fargate image
//     (Dockerfile) and run by plain node through
//     scripts/docker-entrypoint.mjs `migrate`, as a one-off ECS run-task
//     inside the VPC — Aurora has no laptop ingress since 2026-09-01.
// The migrations folder resolves relative to THIS file, not the cwd, so both
// paths find db/migrations without a chdir.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: unknown[] };

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder });

// drizzle's table records hash + created_at only, so the count against the
// journal is the verification line — after a run-task, CloudWatch is the only
// place to read it.
const [row] = await sql<{ count: number; latest: string | null }[]>`
  select count(*)::int as count,
         to_char(to_timestamp(max(created_at) / 1000) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as latest
  from drizzle.__drizzle_migrations
`;
await sql.end({ timeout: 1 });
console.log(
  `migrations applied — ${row?.count ?? 0} in drizzle.__drizzle_migrations ` +
    `(journal has ${journal.entries.length}), latest ${row?.latest ?? "none"}`,
);
