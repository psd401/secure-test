#!/usr/bin/env bash
# The design-tool deploy, as one command (infra/README.md "Deploy").
#
# Encodes the recipe every deploy has followed by hand since 2026-08-31, in
# the order that was learned the expensive way:
#   1. pre-flight: clean tree, HEAD pushed (the image stamps APP_COMMIT from
#      HEAD and /api/health reports it — an unpushed deploy is untraceable),
#      AWS creds valid (SSO login opens a browser, so it stays a human step),
#      colima running (it does not come back after a reboot; the image build
#      fails with "failed to connect to the docker API" otherwise), and
#      packages/schema/dist rebuilt from HEAD (2026-10-02: the design tool
#      consumes the schema package through its gitignored dist, the Dockerfile
#      copies packages/ as-is, so a fresh worktree failed the image build with
#      "Can't resolve '@secure-test/schema'" — and a stale dist in an old
#      checkout would ship silently).
#   2. what is live now: /api/health's commit, and whether this deploy carries
#      new migration files (a diff between two commits, not a guess). DS-2: a
#      deploy that does is refused on weekdays 07:00–15:30 America/Los_Angeles
#      unless --during-school — the old task keeps serving while the new one
#      migrates, and a non-additive migration would break it mid-class.
#   3. cdk diff, printed for the record.
#   4. cdk deploy --require-approval never (no TTY in a scripted run).
#   5. verify: wait (up to DEPLOY_HEALTH_WAIT s, default 600) for /api/health
#      to report HEAD, then print the service's rollout.
#   6. after a healthy deploy only: cdk gc on the bootstrap ECR repository
#      (unreferenced images deleted after 30 days), best-effort.
#
# Migrations (DS-1, 2026-09-25): the container runs them at boot, before the
# server starts (scripts/docker-entrypoint.mjs), so a health stamp == HEAD also
# proves the new image's migrations applied — the server cannot start
# otherwise. A failing migration leaves the new task unhealthy, the circuit
# breaker rolls back, and the old task keeps serving. migrate-aurora.sh stays
# as the manual fallback (infra/README.md "Migrating Aurora").
#
# Usage (from anywhere; AWS creds loaded, colima up):
#   design-tool/infra/scripts/deploy.sh                  # the whole recipe
#   design-tool/infra/scripts/deploy.sh --diff           # pre-flight + diff only
#   design-tool/infra/scripts/deploy.sh --during-school  # override DS-2
#   design-tool/infra/scripts/deploy.sh --staging        # the STAGING stack
#   design-tool/infra/scripts/deploy.sh --no-renderer    # either stack, no signing
#   design-tool/infra/scripts/deploy.sh --backup-prepare DIR  # backup key, step 1
#   design-tool/infra/scripts/deploy.sh --backup-signed DIR   # backup key, step 2
# --staging (renderer slice 2, D-7) deploys SecureTestDesignToolStaging with
# --context env=staging, reads the origin from cdk.context.json's
# staging.domainName, skips DS-2 (no classes run on staging) and runs
# `staging.sh up` before the health wait (its task count is 0 between uses);
# `staging.sh down` afterwards when done. Everything else is the same recipe.
#
# EVERY deploy (staging and production) also keeps THE SIGNED RENDERER
# current (renderer slices 3 / 4e, docs/server-delivered-renderer-design.md
# D-1 / D-2 / 2.a / D-9 / D-11 / D-12), between the diff and `cdk deploy`:
#   a. `bun run build` in packages/renderer -> dist/{renderer.js,
#      renderer.css, manifest.json}. Bridge mode (D-9): the two files are
#      extracted from the client's Swift literals (byte-identical to the page
#      a v1.x client builds).
#   b. D-12 skip rule: read renderers/current.json and the manifest it names
#      from the target stack's asset bucket (stack output AssetBucketName) and
#      verify that manifest's signature. When the new renderer.js and
#      renderer.css have the SAME sha256 as the current manifest's files, its
#      `requires` is the same, and its not_after is more than
#      RENDERER_RESIGN_MARGIN_DAYS (14, James) away -> "renderer unchanged",
#      nothing signed or uploaded, no Touch ID. Otherwise c-f.
#   c. CI gate: HEAD must have a completed, successful `ci` run on GitHub
#      (`gh run list`); in progress -> "wait for ci", failed -> refused. A HEAD
#      that is only OpenWiki bot commits past the last person's commit may use
#      that commit's green run (see ci_gate below).
#   d. packages/renderer/scripts/check-extraction.sh: Swift itself confirms
#      dist/renderer.{js,css} equal AssessmentPage's strings; refused on a
#      mismatch.
#   e. `renderer-sign sign` - a TOUCH ID PROMPT on this Mac (the working key
#      lives in its Secure Enclave), then `renderer-sign verify` against
#      packages/renderer/keys/working.pub.pem; refused on failure.
#   f. upload: renderers/<manifest sha256>/{manifest.json, manifest.sig,
#      renderer.js, renderer.css} - skipped when that manifest is already
#      stored (same hash = same bytes; files under a hash are never
#      rewritten) - then renderers/current.json = {"sha256": ..., "version": ...}
#      LAST, so the pointer never names a half-uploaded renderer.
# Backup key (slice 3b; only when the working key is unavailable - a lost or
# replaced Mac): --backup-prepare DIR runs a-d, writes manifest.json +
# renderer.{js,css} to DIR (outside the repository) and stops - nothing
# uploaded or deployed. The custodians sign DIR/manifest.json on the YubiKey
# and save the DER signature as DIR/manifest.sig. --backup-signed DIR then
# rebuilds, refuses unless DIR's manifest names HEAD, matches this build's
# files and requires and is unexpired, verifies the signature against
# keys/backup.pub.pem, and continues with f and the deploy. Any use starts a
# key rotation (2.a). The D-12 check accepts a current renderer signed by
# either key.
# --no-renderer skips a-f on either stack: an infra-only deploy, no Touch ID;
# the pointer keeps naming the last signed renderer. --diff never signs.
# Production's school-hours rule (DS-2) is unchanged by any of this.
# Env: AWS_REGION (default us-west-2), STACK (default SecureTestDesignTool,
#      or SecureTestDesignToolStaging with --staging),
#      DEPLOY_HEALTH_WAIT (seconds, default 600),
#      RENDERER_RESIGN_MARGIN_DAYS (default 14; D-12).
#
# Exit codes: 1 pre-flight refused; the cdk exit code otherwise; 1 when the
# health stamp never reaches HEAD.
# Known quirk (2026-09-08): the CDK CLI can exit 1 with "SignatureDoesNotMatch:
# Signature expired" while monitoring a long stack event and the stack still
# finishes — step 5 waits for the health stamp and decides.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$INFRA/../.." && pwd)"
export AWS_REGION="${AWS_REGION:-us-west-2}"

DIFF_ONLY=0
DURING_SCHOOL=0
STAGING=0
NO_RENDERER=0
BACKUP_PREPARE=""
BACKUP_SIGNED=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --diff) DIFF_ONLY=1 ;;
    --during-school) DURING_SCHOOL=1 ;;
    --staging) STAGING=1 ;;
    --no-renderer) NO_RENDERER=1 ;;
    --backup-prepare|--backup-signed)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "deploy: $1 needs a directory" >&2; exit 2; }
      if [ "$1" = "--backup-prepare" ]; then BACKUP_PREPARE="$2"; else BACKUP_SIGNED="$2"; fi
      shift ;;
    *) echo "deploy: unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$BACKUP_PREPARE" ] && [ -n "$BACKUP_SIGNED" ]; then
  echo "deploy: pass --backup-prepare or --backup-signed, not both" >&2; exit 2
fi
if { [ -n "$BACKUP_PREPARE" ] || [ -n "$BACKUP_SIGNED" ]; } && { [ "$NO_RENDERER" -eq 1 ] || [ "$DIFF_ONLY" -eq 1 ]; }; then
  echo "deploy: the backup-key flags sign a renderer - not with --no-renderer or --diff" >&2; exit 2
fi
# The backup directory lives outside the repository: inside it, step two's
# clean-tree check would refuse the files step one wrote.
for d in "$BACKUP_PREPARE" "$BACKUP_SIGNED"; do
  [ -z "$d" ] && continue
  case "$(cd "$(dirname "$d")" 2>/dev/null && pwd)/" in
    "$(cd "$(dirname "$0")/../../.." && pwd)/"*)
      echo "deploy: $d is inside the repository - use a directory outside it (e.g. ~/renderer-backup-<date>)" >&2; exit 2 ;;
  esac
done
# The renderer is kept current on every real deploy, staging and production
# (D-11 / D-12); --no-renderer and --diff skip it.
RENDERER=0
if [ "$NO_RENDERER" -eq 0 ] && [ "$DIFF_ONLY" -eq 0 ]; then
  RENDERER=1
fi
RESIGN_MARGIN_DAYS="${RENDERER_RESIGN_MARGIN_DAYS:-14}"
case "$RESIGN_MARGIN_DAYS" in
  ''|*[!0-9]*) echo "deploy: RENDERER_RESIGN_MARGIN_DAYS must be a whole number of days" >&2; exit 2 ;;
esac
if [ "$STAGING" -eq 1 ]; then
  STACK="${STACK:-SecureTestDesignToolStaging}"
  CDK_CTX=(--context env=staging)
  DOMAIN_KEY=".staging.domainName"
else
  STACK="${STACK:-SecureTestDesignTool}"
  CDK_CTX=()
  DOMAIN_KEY=".domainName"
fi
export STACK

say() { printf '\n== %s\n' "$*"; }
fail() { echo "deploy: $*" >&2; exit 1; }

# True when commit $1 is the OpenWiki bot's and touches nothing outside
# openwiki/ — the one kind of commit deploy.sh will step over on its own.
is_bot_openwiki_commit() {
  [ "$(git log -1 --format=%an "$1")" = "psd-automation[bot]" ] || return 1
  [ -z "$(git diff-tree --no-commit-id --name-only -r "$1" | grep -v '^openwiki/' || true)" ]
}

# The `ci` workflow's verdict on commit $1: success | pending | failed | none.
# Several runs can exist for one commit (a re-run); any completed success wins,
# then anything still queued / in progress, then a completed failure.
ci_state() {
  gh run list --repo psd401/secure-test --workflow ci --commit "$1" \
    --json status,conclusion --limit 20 \
    | jq -r 'if any(.[]; .status == "completed" and .conclusion == "success") then "success"
             elif any(.[]; .status != "completed") then "pending"
             elif length > 0 then "failed"
             else "none" end'
}

# Renderer signing gate (2.a): only a commit with a green `ci` run on main is
# signed. The OpenWiki fast-forward above can leave HEAD on a bot commit whose
# own `ci` run may never exist (a push by the bot does not necessarily trigger
# workflows). Rule: when HEAD has NO run at all and HEAD is a bot-only
# openwiki/ commit, walk back over such commits to the newest commit that is
# not, and require THAT commit's run to be green. Sound because the bot's
# commits change only openwiki/, which neither the renderer build nor any test
# reads — the signed files are the ones ci tested; only the manifest's
# `commit` / `version` name the bot commit. A pending or failed run on HEAD
# itself is never stepped over.
ci_gate() {
  local sha="$HEAD_SHA" state
  command -v gh >/dev/null 2>&1 || fail "gh (GitHub CLI) is required for the ci gate — install it and run: gh auth login"
  state="$(ci_state "$sha")" || fail "could not read ci runs from GitHub (gh auth status?)"
  if [ "$state" = "none" ]; then
    while is_bot_openwiki_commit "$sha"; do
      sha="$(git rev-parse "$sha^")"
    done
    if [ "$sha" != "$HEAD_SHA" ]; then
      echo "ci: HEAD is OpenWiki bot commit(s) with no ci run; using $sha (the newest non-bot ancestor)"
      state="$(ci_state "$sha")" || fail "could not read ci runs from GitHub (gh auth status?)"
    fi
  fi
  case "$state" in
    success) echo "ci: green on $sha" ;;
    pending) fail "ci is still running on $sha — wait for ci, then re-run" ;;
    failed) fail "ci failed on $sha — fix it on main before signing a renderer (or deploy with --no-renderer)" ;;
    *) fail "no ci run found for $sha — push it to main and wait for ci (or deploy with --no-renderer)" ;;
  esac
}

# ---------- 1. pre-flight ----------
say "pre-flight"
cd "$REPO"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean — commit or stash first"
HEAD_SHA="$(git rev-parse HEAD)"
git fetch -q origin
# The OpenWiki bot pushes a docs commit after every push to main, which left
# HEAD one behind origin/main before nearly every deploy (2026-10-13).
# Fast-forward ONLY when HEAD is an ancestor of origin/main and every commit
# past it is the bot's and touches nothing outside openwiki/ — anything else
# (a person's commit, local work, a bot commit touching code) still stops.
if [ "$(git rev-parse origin/main)" != "$HEAD_SHA" ] \
  && git merge-base --is-ancestor "$HEAD_SHA" origin/main; then
  BOT_ONLY=1
  for c in $(git rev-list "$HEAD_SHA..origin/main"); do
    is_bot_openwiki_commit "$c" || BOT_ONLY=0
  done
  if [ "$BOT_ONLY" -eq 1 ]; then
    git merge -q --ff-only origin/main
    echo "fast-forwarded over OpenWiki bot commit(s): $HEAD_SHA → $(git rev-parse HEAD)"
    HEAD_SHA="$(git rev-parse HEAD)"
  fi
fi
[ "$(git rev-parse origin/main)" = "$HEAD_SHA" ] || fail "HEAD ($HEAD_SHA) is not origin/main — push first (the image stamps APP_COMMIT from HEAD)"
echo "HEAD = origin/main = $HEAD_SHA"

if [ "$RENDERER" -eq 1 ]; then
  # Signing needs this Mac (Touch ID, the Secure Enclave key, Swift for the
  # extraction check) and gh for the ci gate; the gate itself runs only when
  # a new signature is due (3b).
  [ "$(uname -s)" = "Darwin" ] || fail "renderer signing needs the Mac with the working key - deploy with --no-renderer elsewhere"
  command -v gh >/dev/null 2>&1 || fail "gh (GitHub CLI) is required for the renderer's ci gate - install it and run: gh auth login (or deploy with --no-renderer)"
fi

aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 \
  || fail "AWS credentials missing or expired — run: aws sso login --profile <your-sso-profile>"
echo "AWS creds OK"

colima status >/dev/null 2>&1 || fail "colima is not running — run: colima start"
echo "colima OK"

[ -d "$REPO/node_modules" ] || fail "node_modules missing — run: bun install (repo root)"
(cd "$REPO/packages/schema" && bun run build >/dev/null) \
  || fail "packages/schema build failed — run: cd packages/schema && bun run build"
[ -f "$REPO/packages/schema/dist/index.js" ] || fail "packages/schema/dist/index.js missing after the build"
echo "packages/schema dist rebuilt"

[ -f "$INFRA/cdk.context.json" ] || fail "$INFRA/cdk.context.json missing (copy the .example and fill it)"
ORIGIN="https://$(jq -r "$DOMAIN_KEY" "$INFRA/cdk.context.json")"
[ "$ORIGIN" != "https://null" ] || fail "${DOMAIN_KEY#.} missing from cdk.context.json"
echo "stack $STACK → $ORIGIN"

# ---------- 2. what is live ----------
say "live now"
LIVE_SHA="$(curl -fsS --max-time 15 "$ORIGIN/api/health" | jq -r '.commit // empty' || true)"
if [ -n "$LIVE_SHA" ]; then
  echo "live commit: $LIVE_SHA"
else
  echo "live commit: unknown (health did not answer)"
fi
NEW_MIGRATIONS=""
if [ -n "$LIVE_SHA" ] && git -C "$REPO" cat-file -e "$LIVE_SHA^{commit}" 2>/dev/null; then
  NEW_MIGRATIONS="$(git -C "$REPO" diff --name-only "$LIVE_SHA" "$HEAD_SHA" -- design-tool/db/migrations/ | grep -v '/meta/' || true)"
else
  NEW_MIGRATIONS="(unknown live commit — assuming new migrations)"
fi
if [ -n "$NEW_MIGRATIONS" ]; then
  echo "new migrations (the new task applies them at boot):"
  echo "$NEW_MIGRATIONS"
  # DS-2: school hours = Mon–Fri 07:00–15:30 Pacific.
  DOW="$(TZ=America/Los_Angeles date +%u)"
  HM="$(TZ=America/Los_Angeles date +%H%M)"
  if [ "$STAGING" -eq 0 ] && [ "$DOW" -le 5 ] && [ "$((10#$HM))" -ge 700 ] && [ "$((10#$HM))" -lt 1530 ] && [ "$DURING_SCHOOL" -eq 0 ]; then
    fail "this deploy carries migrations and it is school hours (weekday 07:00–15:30 PT) — deploy after 15:30, or pass --during-school if every migration is additive"
  fi
else
  echo "no new migrations"
fi

# ---------- 3. diff ----------
say "cdk diff"
cd "$INFRA"
bunx cdk diff ${CDK_CTX[@]+"${CDK_CTX[@]}"} || true
[ "$DIFF_ONLY" -eq 1 ] && exit 0

# ---------- 3b. renderer: build, D-12 skip, ci gate, check, sign (Touch ID), upload ----------
RENDERER_SHA=""
RENDERER_VERSION=""
if [ "$RENDERER" -eq 1 ]; then
  say "renderer: build"
  DIST="$REPO/packages/renderer/dist"
  SIGNER="$REPO/tools/renderer-sign/.build/release/renderer-sign"
  WORKING_PUB="$REPO/packages/renderer/keys/working.pub.pem"
  BACKUP_PUB="$REPO/packages/renderer/keys/backup.pub.pem"
  (cd "$REPO/packages/renderer" && bun run build) || fail "renderer build failed"
  [ -f "$DIST/manifest.json" ] || fail "renderer build wrote no dist/manifest.json"
  if [ ! -x "$SIGNER" ]; then
    echo "building renderer-sign (swift build -c release)"
    (cd "$REPO/tools/renderer-sign" && swift build -c release) || fail "renderer-sign build failed"
  fi
  RENDERER_VERSION="$(jq -r '.version' "$DIST/manifest.json")"
  RENDERER_COMMIT="$(jq -r '.commit' "$DIST/manifest.json")"
  [ "$RENDERER_COMMIT" = "$HEAD_SHA" ] || fail "the renderer manifest names $RENDERER_COMMIT, not HEAD $HEAD_SHA"

  BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='AssetBucketName'].OutputValue" --output text 2>/dev/null || true)"
  if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
    fail "no AssetBucketName output on $STACK - deploy once with --no-renderer first"
  fi

  # D-12: re-sign only when the files, the requires list or the validity
  # window call for it. Anything unreadable about the current renderer means
  # sign (the server would refuse it anyway).
  say "renderer: is a new signature due? (D-12)"
  CUR_DIR="$(mktemp -d "${TMPDIR:-/tmp}/renderer-current.XXXXXX")"
  SIGN_REASON=""
  CUR_SHA=""
  CUR_VERSION=""
  CUR_NOT_AFTER=""
  if ! aws s3 cp --only-show-errors "s3://$BUCKET/renderers/current.json" "$CUR_DIR/current.json" >/dev/null 2>&1; then
    SIGN_REASON="no renderers/current.json in s3://$BUCKET (the first signed renderer on $STACK)"
  else
    CUR_SHA="$(jq -r '.sha256 // empty' "$CUR_DIR/current.json" 2>/dev/null || true)"
    if ! printf '%s' "$CUR_SHA" | grep -Eq '^[0-9a-f]{64}$'; then
      SIGN_REASON="renderers/current.json names no manifest sha256"
    elif ! aws s3 cp --only-show-errors "s3://$BUCKET/renderers/$CUR_SHA/manifest.json" "$CUR_DIR/manifest.json" >/dev/null 2>&1 \
      || ! aws s3 cp --only-show-errors "s3://$BUCKET/renderers/$CUR_SHA/manifest.sig" "$CUR_DIR/manifest.sig" >/dev/null 2>&1; then
      SIGN_REASON="the current renderer's manifest or signature is missing"
    elif [ "$(shasum -a 256 "$CUR_DIR/manifest.json" | awk '{print $1}')" != "$CUR_SHA" ]; then
      SIGN_REASON="the current manifest's bytes do not hash to the pointer's sha256"
    elif ! "$SIGNER" verify "$CUR_DIR/manifest.json" "$CUR_DIR/manifest.sig" --public-key "$WORKING_PUB" >/dev/null 2>&1 \
      && ! "$SIGNER" verify "$CUR_DIR/manifest.json" "$CUR_DIR/manifest.sig" --public-key "$BACKUP_PUB" >/dev/null 2>&1; then
      SIGN_REASON="the current manifest's signature verifies against neither keys/working.pub.pem nor keys/backup.pub.pem"
    else
      CUR_JS="$(jq -r '.files["renderer.js"].sha256 // empty' "$CUR_DIR/manifest.json")"
      CUR_CSS="$(jq -r '.files["renderer.css"].sha256 // empty' "$CUR_DIR/manifest.json")"
      CUR_REQ="$(jq -c '.requires' "$CUR_DIR/manifest.json")"
      CUR_NOT_AFTER="$(jq -r '.not_after' "$CUR_DIR/manifest.json")"
      CUR_VERSION="$(jq -r '.version' "$CUR_DIR/manifest.json")"
      # Whole seconds left before not_after (jq's fromdateiso8601 takes no
      # fractional seconds, so the .mmm is dropped first).
      CUR_LEFT="$(jq -r '(.not_after | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now | floor' "$CUR_DIR/manifest.json" 2>/dev/null || true)"
      case "$CUR_LEFT" in ''|*[!0-9-]*) CUR_LEFT=0 ;; esac
      NEW_JS="$(shasum -a 256 "$DIST/renderer.js" | awk '{print $1}')"
      NEW_CSS="$(shasum -a 256 "$DIST/renderer.css" | awk '{print $1}')"
      NEW_REQ="$(jq -c '.requires' "$DIST/manifest.json")"
      if [ "$CUR_JS" != "$NEW_JS" ] || [ "$CUR_CSS" != "$NEW_CSS" ]; then
        SIGN_REASON="the renderer files changed"
      elif [ "$CUR_REQ" != "$NEW_REQ" ]; then
        SIGN_REASON="requires changed ($CUR_REQ -> $NEW_REQ)"
      elif [ "$CUR_LEFT" -le "$((RESIGN_MARGIN_DAYS * 86400))" ]; then
        SIGN_REASON="the current signature expires $CUR_NOT_AFTER (within $RESIGN_MARGIN_DAYS days)"
      fi
    fi
  fi
  rm -rf "$CUR_DIR"
  # The backup-key path always signs: it exists for a renderer that has to
  # change while the working key is unavailable.
  if [ -n "$BACKUP_PREPARE" ] || [ -n "$BACKUP_SIGNED" ]; then
    SIGN_REASON="${SIGN_REASON:-backup-key signing requested}"
  fi

  if [ -z "$SIGN_REASON" ]; then
    RENDERER_SHA="$CUR_SHA"
    RENDERER_VERSION="$CUR_VERSION"
    echo "renderer unchanged - keeping $CUR_SHA (version $CUR_VERSION, valid until $CUR_NOT_AFTER); nothing signed or uploaded"
  else
    echo "a new signature is due: $SIGN_REASON"
    say "renderer: ci gate, extraction check, sign, upload"
    ci_gate
    "$REPO/packages/renderer/scripts/check-extraction.sh" \
      || fail "the extracted renderer is not byte-identical to the Swift page - not signing"
    if [ -n "$BACKUP_PREPARE" ]; then
      # Step one of the backup-key path: hand the exact manifest bytes to the
      # custodians and stop. The manifest's validity window is stamped at
      # build time, so the same file must come back signed.
      [ ! -e "$BACKUP_PREPARE" ] || fail "$BACKUP_PREPARE already exists - give a new directory"
      mkdir -p "$BACKUP_PREPARE"
      cp "$DIST/manifest.json" "$DIST/renderer.js" "$DIST/renderer.css" "$BACKUP_PREPARE/"
      echo
      echo "prepared $BACKUP_PREPARE/manifest.json (renderer $RENDERER_VERSION @ ${HEAD_SHA:0:10}, not_after $(jq -r '.not_after' "$DIST/manifest.json"))"
      echo "next: the backup-key custodians sign manifest.json byte for byte on the YubiKey"
      echo "(docs/server-delivered-renderer-design.md, 'Signing with the backup key'),"
      echo "save the DER signature as $BACKUP_PREPARE/manifest.sig, then run:"
      STAGING_FLAG=""
      [ "$STAGING" -eq 1 ] && STAGING_FLAG="--staging "
      echo "  design-tool/infra/scripts/deploy.sh ${STAGING_FLAG}--backup-signed $BACKUP_PREPARE"
      echo "nothing was uploaded or deployed."
      exit 0
    elif [ -n "$BACKUP_SIGNED" ]; then
      # Step two: the manifest must be the one prepared from THIS commit's
      # files, still valid, and signed by the backup key.
      [ -f "$BACKUP_SIGNED/manifest.json" ] || fail "$BACKUP_SIGNED/manifest.json missing"
      [ -f "$BACKUP_SIGNED/manifest.sig" ] || fail "$BACKUP_SIGNED/manifest.sig missing (the custodians' DER signature)"
      [ "$(jq -r '.commit' "$BACKUP_SIGNED/manifest.json")" = "$HEAD_SHA" ] \
        || fail "$BACKUP_SIGNED/manifest.json names $(jq -r '.commit' "$BACKUP_SIGNED/manifest.json"), not HEAD $HEAD_SHA - prepare again from HEAD"
      for f in renderer.js renderer.css; do
        [ "$(jq -r --arg f "$f" '.files[$f].sha256 // empty' "$BACKUP_SIGNED/manifest.json")" = "$(shasum -a 256 "$DIST/$f" | awk '{print $1}')" ] \
          || fail "$f in this build does not match the prepared manifest - prepare again"
      done
      [ "$(jq -c '.requires' "$BACKUP_SIGNED/manifest.json")" = "$(jq -c '.requires' "$DIST/manifest.json")" ] \
        || fail "requires in this build does not match the prepared manifest - prepare again"
      LEFT="$(jq -r '(.not_after | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now | floor' "$BACKUP_SIGNED/manifest.json" 2>/dev/null || true)"
      case "$LEFT" in ''|*[!0-9-]*) LEFT=0 ;; esac
      [ "$LEFT" -gt 0 ] || fail "the prepared manifest has expired - prepare again"
      "$SIGNER" verify "$BACKUP_SIGNED/manifest.json" "$BACKUP_SIGNED/manifest.sig" --public-key "$BACKUP_PUB" \
        || fail "the signature does not verify against keys/backup.pub.pem - not uploading"
      cp "$BACKUP_SIGNED/manifest.json" "$DIST/manifest.json"
      cp "$BACKUP_SIGNED/manifest.sig" "$DIST/manifest.sig"
      RENDERER_VERSION="$(jq -r '.version' "$DIST/manifest.json")"
      echo "backup-key signature verified - a key rotation is now due (docs/server-delivered-renderer-design.md 2.a)"
    else
      echo "Touch ID: a prompt to sign SecureTest renderer $RENDERER_VERSION @ ${HEAD_SHA:0:10} for $STACK is coming - touch the sensor to sign."
      "$SIGNER" sign "$DIST/manifest.json" --out "$DIST/manifest.sig" || fail "signing refused or failed (Touch ID cancelled?)"
      "$SIGNER" verify "$DIST/manifest.json" "$DIST/manifest.sig" --public-key "$WORKING_PUB" \
        || fail "the signature does not verify against keys/working.pub.pem - not uploading"
    fi
    RENDERER_SHA="$(shasum -a 256 "$DIST/manifest.json" | awk '{print $1}')"

    PREFIX="renderers/$RENDERER_SHA"
    if aws s3api head-object --bucket "$BUCKET" --key "$PREFIX/manifest.json" >/dev/null 2>&1; then
      echo "s3://$BUCKET/$PREFIX/ already stored - files under a hash are never rewritten"
    else
      aws s3 cp --only-show-errors "$DIST/manifest.json" "s3://$BUCKET/$PREFIX/manifest.json" --content-type application/json
      aws s3 cp --only-show-errors "$DIST/manifest.sig" "s3://$BUCKET/$PREFIX/manifest.sig" --content-type application/octet-stream
      aws s3 cp --only-show-errors "$DIST/renderer.js" "s3://$BUCKET/$PREFIX/renderer.js" --content-type text/javascript
      aws s3 cp --only-show-errors "$DIST/renderer.css" "s3://$BUCKET/$PREFIX/renderer.css" --content-type text/css
      echo "uploaded s3://$BUCKET/$PREFIX/ (manifest.json, manifest.sig, renderer.js, renderer.css)"
    fi
    # The pointer LAST, so it never names a renderer whose files are not all there.
    printf '{"sha256":"%s","version":%s}' "$RENDERER_SHA" "$RENDERER_VERSION" \
      | aws s3 cp --only-show-errors - "s3://$BUCKET/renderers/current.json" --content-type application/json
    echo "renderers/current.json -> manifest sha256 $RENDERER_SHA, version $RENDERER_VERSION"
    echo "(the running task picks it up within 60 s; bundles name it with RENDERER_DELIVERY=on)"
  fi
fi

# ---------- 4. deploy ----------
say "cdk deploy"
set +e
bunx cdk deploy ${CDK_CTX[@]+"${CDK_CTX[@]}"} --require-approval never
CDK_EXIT=$?
set -e
[ "$CDK_EXIT" -eq 0 ] || echo "deploy: cdk exited $CDK_EXIT — checking the stack anyway (see the Signature-expired quirk above)"

# ---------- 5. verify ----------
# Wait for /api/health to report HEAD: the new task only starts serving once its
# boot-time migrations applied, and the Signature-expired quirk can make cdk
# exit 1 while the stack still finishes. DEPLOY_HEALTH_WAIT bounds the wait.
wait_for_head() {
  local deadline=$(( $(date +%s) + ${DEPLOY_HEALTH_WAIT:-600} )) sha
  while :; do
    sha="$(curl -fsS --max-time 15 "$ORIGIN/api/health" 2>/dev/null | jq -r '.commit // empty' || true)"
    [ "$sha" = "$HEAD_SHA" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 20
  done
}
say "verify"
# Staging runs no task between uses; start one so there is something to
# answer the health check (staging.sh down when finished).
if [ "$STAGING" -eq 1 ]; then
  "$HERE/staging.sh" up || echo "deploy: staging.sh up failed — the health wait will tell"
fi
HEAD_LIVE=0
wait_for_head && HEAD_LIVE=1
echo "health: $(curl -fsS --max-time 15 "$ORIGIN/api/health" || echo '{}')"
CLUSTER="$(aws ecs list-clusters --query "clusterArns[?contains(@, '${STACK}-')] | [0]" --output text)"
SERVICE="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[0]' --output text)"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{taskDefinition:taskDefinition,rollout:deployments[0].rolloutState,running:runningCount}' --output table
if [ "$HEAD_LIVE" -eq 1 ]; then
  echo "health stamp = HEAD ✅ (boot-time migrations applied)"
  [ -n "$RENDERER_SHA" ] && echo "renderer: version $RENDERER_VERSION, manifest sha256 $RENDERER_SHA"
  [ "$CDK_EXIT" -ne 0 ] && echo "deploy: cdk exited $CDK_EXIT but the new image is serving — treated as success"
  # ---------- 6. image cleanup ----------
  # The app image lands in CDK's shared bootstrap repository, whose only
  # lifecycle rule expires UNTAGGED images — ours are tagged by asset hash, so
  # nothing ever left (32 images / 4.5 GB on 2026-10-03). cdk gc tags images no
  # stack in this account + region references and deletes them once tagged for
  # 30 days (the rollback window). ECR only — the bootstrap S3 bucket is left
  # alone. Only after a healthy deploy, and best-effort: a gc failure never
  # fails the deploy. --unstable=gc: the CLI still flags the command unstable.
  say "image cleanup (cdk gc, ecr, 30-day buffer)"
  (
    ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
    bunx cdk gc "aws://${ACCOUNT}/${AWS_REGION}" --unstable=gc --type ecr \
      --rollback-buffer-days 30 --confirm=false
  ) || echo "deploy: cdk gc failed — images left in place, the deploy itself succeeded"
  exit 0
fi
echo "health stamp never reached HEAD ($HEAD_SHA) — the new task did not go healthy (failed build, failed boot migration, or a rollback). Read the task's logs before re-running." >&2
[ "$CDK_EXIT" -ne 0 ] && exit "$CDK_EXIT"
exit 1
