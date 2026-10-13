#!/usr/bin/env bash
# Proves bridge mode's extraction against Swift itself
# (docs/server-delivered-renderer-design.md D-9). macOS only.
#
# scripts/extract-swift.ts reads the client's Swift string literals as TEXT;
# this script asks the COMPILER. It builds a throwaway SwiftPM executable that
# depends on client/SecureTestCore by path and, through `@testable import`
# (SwiftPM debug builds enable testing), prints the SHA-256 of
#   - AssessmentPage.rendererScript                       → renderer.js
#   - itemStyles + "\n" + richTextStyles                  → renderer.css
# and checks that AssessmentPage.html(...) — the page a v1.x client actually
# loads — contains `<script>` + rendererScript + `</script>` and the two
# sheets as adjacent `<style>` elements, so the served composition is the
# bundled one. Then it compares with packages/renderer/dist/renderer.{js,css}.
#
# Usage (from anywhere, after `bun run build` in packages/renderer):
#   packages/renderer/scripts/check-extraction.sh
# Exit 0 = byte-identical; 1 = a mismatch or a failed Swift build.
# The SwiftPM scratch directory is $TMPDIR/secure-test-renderer-check (outside
# the repo and its Docker context), kept between runs so a re-run only
# recompiles what changed. Nothing under
# client/ is written.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
CORE="$REPO/client/SecureTestCore"
DIST="$PKG/dist"

[ "$(uname -s)" = "Darwin" ] || { echo "check-extraction: macOS only" >&2; exit 1; }
command -v swift >/dev/null 2>&1 || { echo "check-extraction: swift not found" >&2; exit 1; }
for f in renderer.js renderer.css; do
  [ -f "$DIST/$f" ] || { echo "check-extraction: $DIST/$f missing — run bun run build first" >&2; exit 1; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/renderer-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/Sources/check"

cat > "$WORK/Package.swift" <<EOF
// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "RendererExtractionCheck",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "$CORE")],
    targets: [
        .executableTarget(
            name: "check",
            dependencies: [.product(name: "SecureTestCore", package: "SecureTestCore")]
        )
    ]
)
EOF

cat > "$WORK/Sources/check/main.swift" <<'EOF'
import CryptoKit
import Foundation
@testable import SecureTestCore

func hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

let js = AssessmentPage.rendererScript
let css = AssessmentPage.itemStyles + "\n" + AssessmentPage.richTextStyles
let page = AssessmentPage.html(
    title: "check",
    bundleJSON: "{}",
    katex: KatexBundle.Assets(css: "", js: "", autoRender: "", missing: [])
)
var ok = true
if !page.contains("<script>" + js + "</script>") {
    print("page: rendererScript is NOT inlined verbatim as one <script>")
    ok = false
}
let styles = "<style>" + AssessmentPage.itemStyles + "</style>\n<style>"
    + AssessmentPage.richTextStyles + "</style>"
if !page.contains(styles) {
    print("page: itemStyles + richTextStyles are NOT two adjacent <style> elements")
    ok = false
}
print("js \(hex(js))")
print("css \(hex(css))")
print(ok ? "page ok" : "page MISMATCH")
EOF

# Outside the repo: deploy.sh builds the image from the repo root right after
# this check, and packages/ is in the Docker context.
SCRATCH="${TMPDIR:-/tmp}/secure-test-renderer-check"
echo "check-extraction: building SecureTestCore (swift build, debug) …"
swift build --package-path "$WORK" --scratch-path "$SCRATCH" -c debug >"$WORK/build.log" 2>&1 \
  || { cat "$WORK/build.log" >&2; echo "check-extraction: swift build failed" >&2; exit 1; }
OUT="$("$SCRATCH/debug/check")"
echo "$OUT"

SWIFT_JS="$(printf '%s\n' "$OUT" | awk '$1 == "js" { print $2 }')"
SWIFT_CSS="$(printf '%s\n' "$OUT" | awk '$1 == "css" { print $2 }')"
DIST_JS="$(shasum -a 256 "$DIST/renderer.js" | awk '{ print $1 }')"
DIST_CSS="$(shasum -a 256 "$DIST/renderer.css" | awk '{ print $1 }')"
echo "dist js  $DIST_JS"
echo "dist css $DIST_CSS"

STATUS=0
printf '%s\n' "$OUT" | grep -qx "page ok" || STATUS=1
[ -n "$SWIFT_JS" ] && [ "$SWIFT_JS" = "$DIST_JS" ] || { echo "check-extraction: renderer.js differs from AssessmentPage.rendererScript" >&2; STATUS=1; }
[ -n "$SWIFT_CSS" ] && [ "$SWIFT_CSS" = "$DIST_CSS" ] || { echo "check-extraction: renderer.css differs from itemStyles + \"\\n\" + richTextStyles" >&2; STATUS=1; }
if [ "$STATUS" -eq 0 ]; then
  echo "check-extraction: dist/renderer.js and dist/renderer.css are byte-identical to the Swift page"
fi
exit "$STATUS"
