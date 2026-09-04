# 0001. Bun workspaces for the secure-test monorepo

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

Before Slice 1, the repo had no top-level `package.json`. Each PoC (`poc-b-test-loop/infra/`, `poc-c-classlink-sso/infra/`) had its own isolated `package.json` + `node_modules`. The design tool needs a shared TypeScript/Zod package (`@secure-test/schema`) that both the future Next.js app and any backend Lambdas consume — and we want a single place to pin tool versions across all TS code in the repo.

Alternatives considered:
1. Keep each PoC isolated, copy the schema package between consumers, sync by hand.
2. Publish `@secure-test/schema` to a private registry (npm pro / GitHub Packages) and version-pin.
3. Bun workspaces (chosen).

## Decision

Adopt bun workspaces at the repo root. Workspaces: `packages/*` (shared libraries) and `design-tool` (the Next.js app). The PoC `infra/` directories keep their existing isolated installs for now — they'll be migrated only if/when they need to consume the shared schema.

`packageManager` is pinned to `bun@1.3.6` in the root `package.json` so contributors get a stable resolver.

## Consequences

- **Better**: one `bun install` from the repo root; shared deps deduped; refactoring across `packages/` and `design-tool/` is atomic; no manual schema syncing.
- **Worse**: contributors must use bun (not npm/yarn/pnpm) for the workspace code paths to resolve; existing PoC `infra/` directories now coexist with workspace `node_modules` — a small cognitive overhead.
- **Escape hatch**: workspaces are opt-in per directory. Pulling a workspace out into a standalone `package.json` is a one-line change to the root `workspaces` array.
