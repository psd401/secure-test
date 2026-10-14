#!/usr/bin/env bash
# Show, list or move the CURRENT signed renderer (server-delivered renderer
# slice 4f — docs/server-delivered-renderer-design.md "Rolling back the
# renderer"). The rollback lever: every renderer deploy.sh ever signed stays
# stored under renderers/<manifest sha256>/, and renderers/current.json names
# the one delivery bundles hand out. `set` points it back at an earlier one —
# no build, no signing, no Touch ID, no deploy.
#
# Usage (AWS creds for the account loaded; run from anywhere in the repo):
#   design-tool/infra/scripts/renderer-pointer.sh [--staging] show
#   design-tool/infra/scripts/renderer-pointer.sh [--staging] list
#   design-tool/infra/scripts/renderer-pointer.sh [--staging] set <manifest sha256>
#
# `set` refuses unless the target's manifest hashes to <sha256>, its signature
# verifies against keys/working.pub.pem or keys/backup.pub.pem, it has not
# expired, and both files match the manifest — the same checks the server
# makes before naming it (lib/renderer/current.ts), so the pointer never names
# a renderer the server would drop. The running task picks the change up
# within 60 s (the resolver's cache). A shell refuses a renderer below its
# compiled-in minimum version (RendererPolicy.minimumVersion, D-13): rolling
# back past the first production renderer reaches no v2.0 Mac.
#
# Env: AWS_REGION (default us-west-2).
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-west-2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SIGNER="$REPO/tools/renderer-sign/.build/release/renderer-sign"
KEYS="$REPO/packages/renderer/keys"

usage() { echo "usage: renderer-pointer.sh [--staging] show | list | set <manifest sha256>" >&2; exit 2; }
fail() { echo "renderer-pointer: $*" >&2; exit 1; }

STACK="SecureTestDesignTool"
if [ "${1:-}" = "--staging" ]; then
  STACK="SecureTestDesignToolStaging"
  shift
fi
ACTION="${1:-}"
case "$ACTION" in
  show|list) [ "$#" -eq 1 ] || usage ;;
  set) [ "$#" -eq 2 ] || usage
       printf '%s' "$2" | grep -Eq '^[0-9a-f]{64}$' || fail "the target must be a 64-hex manifest sha256 (see: list)" ;;
  *) usage ;;
esac

BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='AssetBucketName'].OutputValue" --output text 2>/dev/null || true)"
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] || fail "no AssetBucketName output on $STACK (AWS creds? aws sso login)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/renderer-pointer.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# One stored manifest's summary line: sha256, version, commit, not_after.
describe() {
  local sha="$1"
  if aws s3 cp --only-show-errors "s3://$BUCKET/renderers/$sha/manifest.json" "$WORK/$sha.json" >/dev/null 2>&1; then
    jq -r --arg sha "$sha" '"\($sha)  v\(.version)  \(.commit[0:10])  not_after \(.not_after)"' "$WORK/$sha.json"
  else
    echo "$sha  (no manifest.json)"
  fi
}

current_sha() {
  aws s3 cp --only-show-errors "s3://$BUCKET/renderers/current.json" - 2>/dev/null | jq -r '.sha256 // empty' || true
}

case "$ACTION" in
  show)
    CUR="$(current_sha)"
    [ -n "$CUR" ] || fail "no renderers/current.json in s3://$BUCKET"
    echo "$STACK current:"
    describe "$CUR"
    ;;

  list)
    CUR="$(current_sha)"
    echo "$STACK stored renderers (newest version first; * = current):"
    aws s3api list-objects-v2 --bucket "$BUCKET" --prefix renderers/ --delimiter / \
      --query 'CommonPrefixes[].Prefix' --output text \
      | tr '\t' '\n' | sed -n 's|^renderers/\([0-9a-f]\{64\}\)/$|\1|p' \
      | while read -r sha; do describe "$sha"; done \
      | sort -t v -k2 -rn \
      | while read -r line; do
          if [ -n "$CUR" ] && [ "${line%% *}" = "$CUR" ]; then echo "* $line"; else echo "  $line"; fi
        done
    ;;

  set)
    TARGET="$2"
    if [ ! -x "$SIGNER" ]; then
      echo "building renderer-sign (swift build -c release)"
      (cd "$REPO/tools/renderer-sign" && swift build -c release) || fail "renderer-sign build failed"
    fi
    D="$WORK/target"
    mkdir -p "$D"
    for f in manifest.json manifest.sig renderer.js renderer.css; do
      aws s3 cp --only-show-errors "s3://$BUCKET/renderers/$TARGET/$f" "$D/$f" >/dev/null 2>&1 \
        || fail "renderers/$TARGET/$f is not stored in s3://$BUCKET (see: list)"
    done
    [ "$(shasum -a 256 "$D/manifest.json" | awk '{print $1}')" = "$TARGET" ] \
      || fail "the stored manifest does not hash to $TARGET"
    "$SIGNER" verify "$D/manifest.json" "$D/manifest.sig" --public-key "$KEYS/working.pub.pem" >/dev/null 2>&1 \
      || "$SIGNER" verify "$D/manifest.json" "$D/manifest.sig" --public-key "$KEYS/backup.pub.pem" >/dev/null 2>&1 \
      || fail "the signature verifies against neither the working nor the backup key"
    for f in renderer.js renderer.css; do
      [ "$(jq -r --arg f "$f" '.files[$f].sha256 // empty' "$D/manifest.json")" = "$(shasum -a 256 "$D/$f" | awk '{print $1}')" ] \
        || fail "$f does not match the manifest"
    done
    LEFT="$(jq -r '(.not_after | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now | floor' "$D/manifest.json" 2>/dev/null || true)"
    case "$LEFT" in ''|*[!0-9-]*) LEFT=0 ;; esac
    [ "$LEFT" -gt 0 ] || fail "that renderer expired $(jq -r '.not_after' "$D/manifest.json") - re-sign with a deploy instead"
    VERSION="$(jq -r '.version' "$D/manifest.json")"
    CUR="$(current_sha)"
    echo "was: $( [ -n "$CUR" ] && describe "$CUR" || echo '(no pointer)')"
    printf '{"sha256":"%s","version":%s}' "$TARGET" "$VERSION" \
      | aws s3 cp --only-show-errors - "s3://$BUCKET/renderers/current.json" --content-type application/json
    echo "now: $(describe "$TARGET")"
    echo "the running task names it within 60 s; a v2.0 shell refuses it if v$VERSION is below its minimum version"
    [ "$LEFT" -gt $((14 * 86400)) ] || echo "warning: expires within 14 days - the expiry alarm will fire"
    ;;
esac
