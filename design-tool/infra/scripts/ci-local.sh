#!/usr/bin/env bash
# The steps of .github/workflows/ci.yml, run on this Mac (2026-11-24).
#
# ci runs on pull requests only (org standard 06 §4), and a hotfix branch cut
# from the live commit conflicts with main, so its pull request never gets a
# run. `deploy.sh --hotfix` runs this instead of reading a GitHub run. Mirror
# ci.yml step for step - when one changes, change the other.
#
# Needs the local Postgres with the test database (AGENTS.md "Dev"). Env:
#   CI_LOCAL_DATABASE_URL (default postgres://$USER@localhost:5432/secure_test_design_tool_test)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
export DATABASE_URL="${CI_LOCAL_DATABASE_URL:-postgres://$USER@localhost:5432/secure_test_design_tool_test}"
export NEXT_TELEMETRY_DISABLED=1

step() { printf '\n-- ci-local: %s\n' "$*"; }

cd "$REPO"
step "install"
bun install --frozen-lockfile

step "schema: build + test"
(cd packages/schema && bun run build && bun test)
step "renderer: build + test"
(cd packages/renderer && bun run build && bun test)
step "markup: typecheck + test"
(cd packages/markup && bun run typecheck && bun test)
step "graphing: typecheck + test"
(cd packages/graphing && bun run typecheck && bun test)
step "design tool: typecheck"
(cd design-tool && bun run typecheck)
step "design tool: next build"
(cd design-tool && bun run build)
step "design tool: migrate the test database"
(cd design-tool && bun db/migrate.ts)
step "design tool: test"
(cd design-tool && bun test)

echo
echo "ci-local: all steps passed"
