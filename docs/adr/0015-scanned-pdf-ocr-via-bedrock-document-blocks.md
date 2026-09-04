# 0015. Scanned-PDF OCR via Bedrock Converse document blocks

- **Status**: Accepted
- **Date**: 2026-08-13

## Context

Slice 42 (`docs/phase-3-slices.md`) shipped PDF item import for text-layer PDFs: `unpdf` extracts the text, the extractor LLM proposes item candidates, and the teacher reviews them per-item before anything is written (the route itself writes nothing). Scanned/image PDFs are detected by a chars-per-page heuristic (`lib/pdfImport/extractText.ts` — under 40 non-whitespace chars per page) and rejected with 422 `pdf_looks_scanned`. OCR was deferred in-slice but flagged a **definite future need** (James, 2026-07-09).

Two facts shape the mechanism choice:

- **Local rasterization is unavailable here.** The ADR 0013 spike showed headless Chrome hangs on this dev box; a pdf→image pipeline (rasterize, then send images) cannot be developed or verified locally.
- **Bedrock Converse accepts document content blocks.** Raw PDF bytes attach to the user message and Claude reads the pages directly — visually, for pages with no text layer — with no client-side rasterization or OCR library. The installed `@aws-sdk/client-bedrock-runtime` (`^3.1069.0`) already types `DocumentBlock`; no dependency change is needed.

The insertion point already holds the bytes: the import route reads the upload into a `Uint8Array` before text extraction, so the scanned branch can forward the same bytes it was about to reject.

## Decision

**Scanned-PDF OCR = a Converse document block through the existing `converseText` wrapper.** Concretely:

- `converseText` (`lib/ai/bedrockConverse.ts`) gains an optional `document: { bytes, name }`; when present, a `{ document: { format: "pdf", … } }` block precedes the text block. Document names are sanitized in the wrapper (Bedrock rejects periods and most punctuation in document names — callers should not need to know that rule). Existing callers pass no document and are unchanged.
- The scanned branch (slice 44) reuses the **same provider seam and prompt**: `PDF_EXTRACTOR_PROVIDER` env switch with `mock` as the test/CI default, `PDF_EXTRACT_SYSTEM_PROMPT` unchanged, candidates validated by the single `validatePdfCandidates` → `CreateItemBody` authority, same propose-then-edit UI. OCR is a transport change, not a new pipeline.
- **Guardrail policy (approved 2026-08-13):** the pre-model *input* stage is skipped on the scanned branch — there is no extracted text to screen before the model runs, and the PDF bytes are not screenable text. The *output* stage on candidate stems is unchanged. Surface stays `pdf-import` (already in the `guardrail_events.surface` CHECK — no migration).
- **Caps (approved 2026-08-13):** 30 pages on the scanned branch (`pageCount` is known from `unpdf` before any model call, so the cap costs nothing). AWS documents per-document Converse size limits far below the route's 25 MiB `MAX_BYTES`, so slice 44 also enforces a smaller byte cap on the scanned branch; slice 45 validates the real limits empirically against live Bedrock and records the numbers here.

## Consequences

- **Better**: no new dependencies; same SigV4/IAM/model wiring as every other AI surface (ADR 0007/0011); works within the ADR 0013 constraint. OCR quality is Claude's vision — a degraded scan yields fewer/worse candidates, but they land in the same review UI where the teacher edits or discards them, so the failure mode is graceful.
- **Worse**: image-read pages are token-heavy compared to extracted text — the page cap bounds spend, but a scanned import is materially slower and costlier than a text-layer one. Model remains `BEDROCK_PDF_EXTRACT_MODEL` (default Sonnet 4.6); revisit if OCR quality demands otherwise.
- **Validated live (slice 45, 2026-08-13, us-west-2, `us.anthropic.claude-sonnet-4-6`):**
  - **Candidate quality:** a 2-page image-only fixture (150 dpi renders of a fake grade-5 quiz with an answer key; `design-tool/test/fixtures/scanned-test.pdf`) yielded **5/5 valid candidates, 0 rejected** — 2× MC-single, 1× MC-multi (both correct ids read from the answer key), short_text (`Olympia` from the key), essay. Latency **~18.6 s** for 2 pages.
  - **Size limit:** the documented 4.5 MB per-document Converse limit is **not enforced** on this path — padded probes at 4.3, 4.6, 6, and 10 MiB were all accepted (7–10 s each). The real ceiling is **≥ 10 MiB**; `MAX_OCR_BYTES` was raised from 4.5 MiB to the validated **10 MiB** (approved by James 2026-08-13) so 30-page scans at 150–200 dpi fit, still bounded by the route's 25 MiB `MAX_BYTES`.
  - `bedrockPdfExtractor` request construction is unit-tested (both shapes, mocked client), and `scripts/bedrock-smoke.ts` gained a permanent OCR section driving the committed fixture.
- Tests never touch AWS: the mock extractor stays the default, and route tests drive the scanned branch with generated image-only PDFs (the bun `mock.module` cross-file leak rules out module-mocking shared deps — see the slice 42 note in `docs/phase-3-slices.md`).
