# @secure-test/renderer

The student test page's renderer, as the files the design tool serves to
the macOS shell, plus their manifest
(`docs/server-delivered-renderer-design.md`, slices 3 and 4e).

## Bridge mode (D-9)

Until slice 5 moves the page code here, there is NO renderer source in this
package. The build **extracts** the two served files from the client's
Swift string literals, so the served renderer is byte-identical to the page
a v1.x client builds at run time, and page edits keep landing in Swift:

| Served file | Swift source |
|---|---|
| `renderer.js` | `AssessmentPage.rendererScript` (`client/.../AssessmentPage.swift`), with `\#(mathPassFunctions)` (same file) and `\#(richTextFunctions)` (`AssessmentPageRichText.swift`) spliced in, as Swift does |
| `renderer.css` | `AssessmentPage.itemStyles + "\n" + richTextStyles` |

The page inlines `itemStyles` and `richTextStyles` as two adjacent `<style>`
elements (`PageShell.document` joins its style blocks with `\n`); the served
CSS is the two joined by one newline, and **the v2.0 shell (slice 4c) inlines
it as ONE `<style>` element** — the same rules in the same order.

What stays in the shell for now: KaTeX itself and its CSS, the KaTeX macros
(`KATEX_MACROS`, D-4 — they move in slice 5), `PageShell`'s base and
accommodation styles, the fonts, and the page globals the renderer reads —
`BUNDLE`, `OFFLINE`, `TTS_SCOPE`, `STT_STATE` and
`KATEX_MACROS` — plus the `<h1>` and `<div id="items">` body.

`scripts/extract-swift.ts` is a narrow reader, not a Swift parser: multi-line
`static let` literals only, the closing delimiter's indentation stripped
(Swift's rules, including its refusal of an under-indented line), `\#(name)`
interpolation of another extracted literal in raw literals, and in plain
literals the escapes `\\ \" \' \n \t \r \0 \u{…}`. Anything else — `\(…)`,
a line continuation, another `\#` escape, an unknown name, a cycle, CR line
ends, tabs — fails the build rather than ship a renderer that differs from
the bundled one. `test/extract.test.ts` covers those rules on synthetic
snippets (expected values produced by `swift` itself) and pins the real
page's shape.

**Proof against Swift: `scripts/check-extraction.sh`** (macOS). It builds a
throwaway SwiftPM executable that depends on `client/SecureTestCore` by path
and, through `@testable import`, prints the SHA-256 of
`AssessmentPage.rendererScript` and of the CSS composition, and checks that
`AssessmentPage.html(...)` inlines exactly those strings; then it compares
them with `dist/`. Run it after `bun run build`; `deploy.sh` runs it before
every signature. It writes nothing in the repository (SwiftPM scratch in
`$TMPDIR/secure-test-renderer-check`, outside the Docker build context the
deploy uses next). CI (ubuntu) runs the extraction and its tests
but not this check.

Signing is done by `tools/renderer-sign` (Secure Enclave working key, Touch
ID per signature) and checked by `src/verify.ts`. `deploy.sh` signs and
uploads the built files on staging and production when a signature is due
(D-12), and the design tool serves them at
`/api/renderer/<manifest sha256>/<file>` — see `design-tool/infra/README.md`
"The signed renderer".

## Scripts

- `bun run build` — extracts and writes `dist/renderer.js`,
  `dist/renderer.css` and `dist/manifest.json` (gitignored), and prints a
  one-line summary. Refuses `</` in either file.
- `scripts/check-extraction.sh` — the Swift equality check above (macOS).
- `bun run keys` — regenerates `src/keys.ts` (the trusted public keys as
  string constants, so the design tool's standalone build carries them with
  no file path) from `keys/*.pub.pem`. Run it after adding or replacing a
  key; `test/keys.test.ts` fails while the two drift.
- `bun test` — the extractor (synthetic Swift and the real page: shape,
  no `</`, the `requires` list re-derived from the page's
  `messageHandlers`), manifest building, canonical bytes, parsing,
  signature verification and the use checks, and a cross-language fixture
  signed by the Swift tool.

The persistent DEV public key lives in `dev-keys/dev.pub.pem`, deliberately
OUTSIDE `keys/`, so `bun run keys` never compiles it into the server's
accepted keys; only the client's Debug build may trust it (slice 4). Its
private half stays outside the repository.

## Manifest

| Field | Meaning |
|---|---|
| `format` | `1`. |
| `version` | Positive integer: HEAD's committer time in unix seconds. `main` has linear history, so it only rises; the shell compares it with its minimum version (D-2). |
| `commit` | The 40-hex SHA the files were built from. Only a commit with a green `ci` run on `main` is signed. |
| `issued_at`, `not_after` | ISO-8601 UTC (`…Z`); `not_after` = `issued_at` + 60 days. |
| `requires` | Sorted, de-duplicated terms from `src/requires.ts`'s vocabulary (the eight bridge handlers plus host features `tts.word_ranges` and `response.generic`, D-4 / D-5). The bridge renderer requires `BRIDGE_REQUIRES` = the seven handlers the page posts to (all but `home`, since 2026-10-24) + `tts.word_ranges` — not `response.generic`, which arrives with D-5. |
| `files` | Published name → `{ sha256, bytes }`, sha256 as lowercase hex. |

## Canonical form

`canonicalManifestBytes` is the byte form that is signed and served: UTF-8
JSON, no insignificant whitespace, object keys sorted recursively, arrays
in order, safe integers only. `parseManifest` refuses bytes that are not
the canonical form of what they parse to, so one manifest has exactly one
byte form.

## Verifying (`src/verify.ts`)

- `verifyManifestSignature(bytes, derSignature, publicKeysPem)` — true when
  ANY of the keys (working, backup) verifies an ECDSA P-256 / SHA-256 DER
  signature over the exact bytes. A malformed signature is false; a key that
  is not P-256 throws.
- `checkManifestUse(manifest, { now, minVersion })` — refuses
  `below_min_version`, `not_yet_valid` (before `issued_at`) and `expired`
  (after `not_after`); both window ends are inclusive.

Order: verify the bytes, then `parseManifest`, then `checkManifestUse`.
`test/fixtures/cross-language/` holds a manifest signed by
`tools/renderer-sign` with a throwaway dev key (only its public half is
committed); `test/verify.test.ts` says how to regenerate it.

## Rules for the renderer's JavaScript

Plain browser JavaScript: no imports, no network, no `eval`, and never the
sequence `</` (the shell inlines it into a script element; the CSS likewise
into a style element). The build and the tests check the last rule on both
files.
