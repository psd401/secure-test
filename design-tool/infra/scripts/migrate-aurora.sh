#!/usr/bin/env bash
# Migrate Aurora from INSIDE the VPC (infra/README.md "Migrating Aurora").
#
# Since slice 4 of docs/scoring-corpus-design.md this is a thin wrapper: the
# run-task machinery it used to carry lives in oneoff-aurora.sh, which takes
# an entrypoint mode and passes the rest through. This name stays because the
# docs, the deploy recipe and muscle memory all use it.
#
# Usage (AWS creds for the account loaded; nothing to pass):
#   design-tool/infra/scripts/migrate-aurora.sh
# Env: AWS_REGION (default us-west-2), STACK (default SecureTestDesignTool).
#
# Idempotent: drizzle applies only what drizzle.__drizzle_migrations lacks.
# Run it after every `cdk deploy` that shipped new migrations — the image
# carries the migrations it was built with, so deploy FIRST, then migrate.
set -euo pipefail
exec "$(dirname "$0")/oneoff-aurora.sh" migrate "$@"
