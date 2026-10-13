# @secure-test/renderer

The student test page's renderer, as the files the design tool will serve
to the macOS shell, plus their manifest
(`docs/server-delivered-renderer-design.md`, slice 3).

**The renderer here is a PLACEHOLDER.** Slice 5 moves the real page code,
the KaTeX macros and their tests in from the client, byte for byte. Signing
the manifest (next commit) and serving it (the commit after) are not built
yet.

## Scripts

- `bun run build` — writes `dist/renderer.js`, `dist/renderer.css` and
  `dist/manifest.json` (gitignored), and prints a one-line summary.
- `bun test` — manifest building, canonical bytes, parsing, and the
  no-`</` rule for `src/renderer.js`.

## Manifest

| Field | Meaning |
|---|---|
| `format` | `1`. |
| `version` | Positive integer: HEAD's committer time in unix seconds. `main` has linear history, so it only rises; the shell compares it with its minimum version (D-2). |
| `commit` | The 40-hex SHA the files were built from. Only a commit with a green `ci` run on `main` is signed. |
| `issued_at`, `not_after` | ISO-8601 UTC (`…Z`); `not_after` = `issued_at` + 60 days. |
| `requires` | Sorted, de-duplicated terms from `src/requires.ts`: the eight bridge handlers plus host features `tts.word_ranges` and `response.generic` (D-4 / D-5). |
| `files` | Published name → `{ sha256, bytes }`, sha256 as lowercase hex. |

## Canonical form

`canonicalManifestBytes` is the byte form that is signed and served: UTF-8
JSON, no insignificant whitespace, object keys sorted recursively, arrays
in order, safe integers only. `parseManifest` refuses bytes that are not
the canonical form of what they parse to, so one manifest has exactly one
byte form.

## Rules for `src/renderer.js`

Plain browser JavaScript: no imports, no network, no `eval`, and never the
sequence `</` (the client inlines it into a script element). The build and
the tests both check the last rule.
