#!/usr/bin/env bash
# A READ-ONLY ad-hoc query against Aurora from a laptop, in one shell:
#
#   design-tool/infra/scripts/query-aurora.sh <file.sql>
#
# The one-shell form of infra/README.md "Ad-hoc psql from a laptop": opens
# the cluster security group to this machine's public /32, reads the cluster
# secret, runs the file inside a read-only session, and revokes the rule on
# ANY exit (normal, error, Ctrl-C) — including a rule an earlier interrupted
# run left behind. Nothing in this file is a secret: the group and the
# secret are looked up by name at run time with the caller's own AWS
# credentials (`aws sso login` first).
#
# Read-only is enforced at the database, not by convention:
# `default_transaction_read_only = on` is set on the session before the file
# runs, so any INSERT / UPDATE / DELETE / DDL fails; a file that tries to
# switch the setting back is refused before it runs. For writes use the
# migration path or the in-VPC one-off runner (oneoff-aurora.sh).
set -euo pipefail

SQL="${1:?usage: query-aurora.sh <file.sql>}"
[ -f "$SQL" ] || { echo "no such file: $SQL" >&2; exit 2; }
if grep -qiE 'transaction_read_only|set +session +characteristics' "$SQL"; then
  echo "refusing: $SQL touches the read-only setting" >&2; exit 2
fi
for tool in aws jq psql curl; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
done

export AWS_REGION="${AWS_REGION:-us-west-2}"
aws sts get-caller-identity --query Arn --output text >/dev/null \
  || { echo "AWS credentials missing or expired — aws sso login first" >&2; exit 2; }

SG=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values='SecureTestDesignTool-ClusterSg*' \
  --query 'SecurityGroups[0].GroupId' --output text)
[ -n "$SG" ] && [ "$SG" != "None" ] || { echo "cluster security group not found" >&2; exit 1; }
ME="$(curl -s https://checkip.amazonaws.com)/32"

# The revoke is armed BEFORE the authorize so an interrupted run never leaves
# the rule behind, and it also clears a rule from an earlier interrupted run.
trap 'aws ec2 revoke-security-group-ingress --group-id "$SG" --protocol tcp --port 5432 --cidr "$ME" >/dev/null 2>&1 \
        && echo "SG rule revoked" || echo "SG rule already gone"' EXIT INT TERM
echo "opening $SG to $ME for the duration of this query"
if ! OUT=$(aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 5432 --cidr "$ME" 2>&1); then
  echo "$OUT" | grep -q InvalidPermission.Duplicate || { echo "$OUT" >&2; exit 1; }
  echo "rule was already present (left by an earlier run) — it will be revoked on exit"
fi

SECRET_ARN=$(aws secretsmanager list-secrets \
  --query "SecretList[?starts_with(Name, 'SecureTestDesignToolCluster')].ARN | [0]" --output text)
DATABASE_URL=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text \
  | jq -r '"postgres://\(.username):\(.password)@\(.host):\(.port)/\(.dbname)?sslmode=require"')

# Aurora Serverless may be paused at 0 ACU: the first connect can take ~30 s.
for i in 1 2 3 4 5 6; do
  psql "$DATABASE_URL" -Atc "select 1" >/dev/null 2>&1 && break
  echo "cluster resuming… ($i)"; sleep 10
done

# One connection, so the session-level read-only setting covers every
# statement in the file. PAGER=cat: no "(END)" prompt waiting on a keypress.
PAGER=cat psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "set default_transaction_read_only = on" \
  -f "$SQL"
