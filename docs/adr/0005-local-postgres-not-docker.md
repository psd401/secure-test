# 0005. Local Postgres via homebrew, not Docker

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

Slice 4 introduces a real database for assessment persistence. The broader design-tool plan locks Aurora Postgres Serverless v2 for production, but production deployment is not in scope until later slices. Local development needs a Postgres instance that:

1. Matches Aurora's wire protocol and SQL dialect (so Drizzle migrations port over without rewrite).
2. Is fast to iterate against (no container startup, no port collisions).
3. Doesn't introduce a new dependency on James's workstation.

Options considered:

1. **Docker Postgres via docker-compose.** Industry standard. Requires Docker Desktop or OrbStack installed. James does not currently have Docker installed (`which docker` → not found).
2. **SQLite via Bun's native driver.** Zero dependencies; in-process. But Drizzle's SQLite dialect differs from Postgres (no `jsonb`, no arrays, different default-expression syntax). Schemas would diverge or have to be written in a Postgres subset, then re-validated against Aurora later.
3. **Homebrew Postgres 16, already installed and running** (`postgresql@16` started; `pg_isready` returns accepting). Already used by another project on this machine.

## Decision

Use the existing homebrew Postgres 16. Two databases: `secure_test_design_tool_dev` and `secure_test_design_tool_test`. Connection string in `DATABASE_URL`; default for local is `postgres://${USER}@localhost:5432/secure_test_design_tool_dev`.

Drizzle's `postgres-js` driver, Drizzle Kit migrations checked into `design-tool/db/migrations/`.

## Consequences

- **Better**: zero setup friction on James's machine; identical SQL dialect, types (`jsonb`, `timestamp with time zone`, `gen_random_uuid()`), and constraint behavior as Aurora; fast iteration with no container overhead.
- **Worse**: not portable to a new contributor without homebrew Postgres installed. CI will need its own Postgres container, or a service binding when GitHub Actions lands.
- **Escape hatch**: when Aurora deployment lands (later slice), `DATABASE_URL` is the only thing that changes. Drizzle Kit migrations are wire-compatible. If a future contributor needs Docker, a `docker-compose.yml` can be added without changing application code — both setups produce the same `postgres://...` URL.
