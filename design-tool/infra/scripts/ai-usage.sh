#!/usr/bin/env bash
# READ-ONLY: what Bedrock calls the deployed app made, from its `ai_usage`
# log lines (lib/ai/bedrockConverse.ts), with an estimated cost per surface.
#
#   design-tool/infra/scripts/ai-usage.sh                       # last 30 days
#   design-tool/infra/scripts/ai-usage.sh --days 7
#   design-tool/infra/scripts/ai-usage.sh --exclude-sub <sub>   # repeatable
#   design-tool/infra/scripts/ai-usage.sh --by-owner            # + per-teacher rows
#
# Runs a CloudWatch Logs Insights query against the app log group with the
# caller's own AWS credentials (`aws sso login` first) — no VPC access, no
# database, nothing written. The app keeps 30 days of logs, so --days caps
# at 30; run it before the window you care about ages out.
#
# Excluding test traffic: every line carries `owner_sub`, the Google subject
# id of the teacher whose action made the call. Pass the maintainer's and the
# demo accounts' subs with --exclude-sub, or put them comma-separated in
# AI_USAGE_EXCLUDE_SUBS in your shell profile. Never commit sub values —
# they identify real accounts. A line with no owner_sub (a CLI run such as
# the scoring corpus) is kept and shows as "(none)" under --by-owner.
#
# Cost: tokens × the per-1M prices in PRICES below — the US cross-region
# (`us.` model id) on-demand rates from the AWS Price List API for us-west-2,
# 2026-10-03. ApplyGuardrail is billed per text unit and logs no tokens, so it
# is not counted. A model missing from PRICES prints "?".
set -euo pipefail

DAYS=30
BY_OWNER=0
EXCLUDE="${AI_USAGE_EXCLUDE_SUBS:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="${2:?--days needs a number}"; shift 2 ;;
    --exclude-sub) EXCLUDE="${EXCLUDE:+$EXCLUDE,}${2:?--exclude-sub needs a value}"; shift 2 ;;
    --by-owner) BY_OWNER=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$DAYS" =~ ^[0-9]+$ ]] && [ "$DAYS" -ge 1 ] && [ "$DAYS" -le 30 ] \
  || { echo "--days must be 1–30 (log retention is 30 days)" >&2; exit 2; }
for tool in aws jq; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
done

export AWS_REGION="${AWS_REGION:-us-west-2}"
ENV_NAME="${ENV_NAME:-dev}"
LOG_GROUP="/ecs/secure-test-design-tool-${ENV_NAME}"
aws sts get-caller-identity --query Arn --output text >/dev/null \
  || { echo "AWS credentials missing or expired — aws sso login first" >&2; exit 2; }

# $ per 1M tokens: input output. Update from the AWS Price List API
# (service AmazonBedrockFoundationModels / AmazonBedrock, regionCode us-west-2).
PRICES='{
  "us.anthropic.claude-sonnet-4-6": [3.3, 16.5],
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": [1.1, 5.5],
  "us.anthropic.claude-sonnet-5-5": [2.2, 11],
  "us.anthropic.claude-opus-5-5": [4.4, 22]
}'

FILTER='filter event = "ai_usage"'
if [ -n "$EXCLUDE" ]; then
  LIST=$(printf '%s' "$EXCLUDE" | jq -Rr 'split(",") | map(select(length > 0) | @json) | join(", ")')
  FILTER="$FILTER | filter not ispresent(owner_sub) or owner_sub not in [$LIST]"
fi

run_query() {
  local q="$1" qid status
  qid=$(aws logs start-query --log-group-name "$LOG_GROUP" \
    --start-time "$(( $(date +%s) - DAYS * 86400 ))" --end-time "$(date +%s)" \
    --query-string "$q" --query queryId --output text)
  for _ in $(seq 1 60); do
    status=$(aws logs get-query-results --query-id "$qid" --query status --output text)
    case "$status" in
      Complete) break ;;
      Failed|Cancelled|Timeout) echo "query $status" >&2; exit 1 ;;
    esac
    sleep 2
  done
  [ "$status" = Complete ] || { echo "query did not finish in 2 minutes" >&2; exit 1; }
  # One JSON object per result row: {field: value, ...}
  aws logs get-query-results --query-id "$qid" --output json \
    | jq -c '.results[] | map({(.field): .value}) | add'
}

echo "ai_usage in $LOG_GROUP, last $DAYS day(s)$([ -n "$EXCLUDE" ] && echo ", excluding $(printf '%s' "$EXCLUDE" | tr ',' '\n' | grep -c .) owner(s)")"
echo

run_query "$FILTER | stats count(*) as calls, avg(input_tokens) as avg_in, avg(output_tokens) as avg_out, sum(input_tokens) as sum_in, sum(output_tokens) as sum_out, count_distinct(owner_sub) as owners by surface, model | sort calls desc" \
  | jq -rs --argjson prices "$PRICES" '
      def n: (. // "0") | tonumber;
      def cost($m; $i; $o): ($prices[$m] // null) as $p
        | if $p == null then null else ($i * $p[0] + $o * $p[1]) / 1e6 end;
      def money: if . == null then "?" else "$" + ((. * 100 | round) / 100 | tostring) end;
      (["surface", "model", "calls", "owners", "avg in", "avg out", "est $", "$/call"] | @tsv),
      (.[] | (cost(.model; (.sum_in | n); (.sum_out | n))) as $c
        | [.surface, (.model | sub("^us\\.anthropic\\."; "")), .calls, .owners,
           (.avg_in | n | round), (.avg_out | n | round), ($c | money),
           (if $c == null then "?" else "$" + (($c / (.calls | n)) * 10000 | round / 10000 | tostring) end)]
        | @tsv),
      (map(cost(.model; (.sum_in | n); (.sum_out | n)) // 0) | add // 0
        | ["", "", "", "", "", "total", (. | money), ""] | @tsv)
    ' | column -t -s $'\t'

if [ "$BY_OWNER" -eq 1 ]; then
  echo
  echo "per owner (owner_sub is an opaque Google id — do not paste these into tracked files)"
  run_query "$FILTER | fields coalesce(owner_sub, \"(none)\") as owner | stats count(*) as calls, sum(input_tokens) as sum_in, sum(output_tokens) as sum_out by owner, surface, model | sort owner asc, calls desc" \
    | jq -rs --argjson prices "$PRICES" '
        def n: (. // "0") | tonumber;
        (["owner", "surface", "calls", "est $"] | @tsv),
        (.[] | ($prices[.model] // null) as $p
          | [.owner, .surface, .calls,
             (if $p == null then "?" else "$" + ((((.sum_in | n) * $p[0] + (.sum_out | n) * $p[1]) / 1e6 * 100 | round) / 100 | tostring) end)]
          | @tsv)
      ' | column -t -s $'\t'
fi
