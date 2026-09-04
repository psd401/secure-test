# Fargate image for the design tool (docs/ecs-deploy-plan.md slice 1).
# Build from the REPO ROOT — the bun workspace needs packages/ in context:
#   docker build -f design-tool/Dockerfile .
#
# Base pins (2026-08-31): node 22.23.2 = current LTS patch on Docker Hub;
# bun 1.3.6 = the root package.json packageManager pin. Bump both here
# deliberately, not by floating tags. No network egress during `next build`
# — fonts are vendored (app/fonts/, plan decision 1.4).

FROM node:22.23.2-slim AS builder
# next's CLI needs node; bun is only the package manager + script runner.
COPY --from=oven/bun:1.3.6 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo

# Workspace manifests first so the install layer caches across src edits.
COPY package.json bun.lock ./
COPY packages/schema/package.json packages/schema/package.json
COPY design-tool/package.json design-tool/package.json
RUN bun install --frozen-lockfile

COPY packages packages
COPY design-tool design-tool
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd design-tool && bun run build
# Migration runner (infra slice, 2026-09-01): the standalone trace carries
# neither bun nor drizzle-orm/postgres as resolvable modules (Next bundles
# them into the server chunks), so db/migrate.ts is bundled into one
# self-contained ESM file that plain node runs. Lives next to db/migrations
# because migrate.ts resolves the folder relative to its own location.
RUN cd design-tool && bun build db/migrate.ts --target=node --format=esm --outfile db/migrate.mjs

FROM node:22.23.2-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

# Standalone layout mirrors the workspace (outputFileTracingRoot = repo
# root): server.js sits under design-tool/. Next 16 copies public/ into
# the standalone output but NOT .next/static — that one is manual.
COPY --from=builder /repo/design-tool/.next/standalone ./
COPY --from=builder /repo/design-tool/.next/static ./design-tool/.next/static
COPY --from=builder /repo/design-tool/public ./design-tool/public
# Boot shim (slice 3): assembles DATABASE_URL from the ECS-injected DB_*
# secret vars, then imports server.js — or, with `migrate` as its argument,
# the bundled migrator (a one-off ECS run-task; infra/README.md "Migrating
# Aurora"). Local runs that set DATABASE_URL directly pass straight through.
COPY --from=builder /repo/design-tool/scripts/docker-entrypoint.mjs ./design-tool/scripts/docker-entrypoint.mjs
COPY --from=builder /repo/design-tool/db/migrate.mjs ./design-tool/db/migrate.mjs
COPY --from=builder /repo/design-tool/db/migrations ./design-tool/db/migrations

USER node
EXPOSE 3000
CMD ["node", "design-tool/scripts/docker-entrypoint.mjs"]
