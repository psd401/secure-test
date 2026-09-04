# Stimulus and item sets — design (draft 2026-09-01)

E5 in `pdf-import-enhancements.md`: the paragraph, graph, table, or map that a
question depends on. Today it has nowhere to live — every item stands alone, and
text-layer extraction drops images before the model sees anything — so the 2026-09-01
sample-import run lost the context above most Unit 0 items, the graph under Unit 1
item 13, and the table image for item 15. This document is the measured foundation
plus a proposed shape; the decisions section is deliberately open until teachers have
been asked the two questions the sample cannot answer.

## The measured foundation

**Code, as of `main` 09882d5 + slices A–C.**

- Extraction: `lib/pdfImport/extractText.ts` (unpdf) returns text only. Scanned PDFs
  go to Bedrock as page images (ADR 0015); text-layer PDFs never do. No figure ever
  reaches the model or the teacher.
- Item shapes the extractor can propose: MC single/multi, short_text, essay. The app
  has eight types; `match`, `order`, `hotspot`, `drawing_upload` are never proposed
  (E1, E2, E4 in the enhancement checklist).
- Content model: `items.stem` is plain text plus KaTeX (ADR 0009) plus
  `![alt](asset:uuid)` image refs (ADR 0010) resolved from owner-scoped `assets`.
  No grouping concept anywhere in `db/schema.ts` or `lib/api/items.ts`.
- Consumers a stimulus would touch: editor (`AssessmentEditor.tsx`), preview/print
  (`lib/preview/renderHtml.ts`), the teacher export bundle and
  `importBundleForOwner` (sharing rides on these, slice C), the student delivery
  bundle (`lib/api/buildDeliveryBundle.ts`, ADR 0016), the Swift client's item layout,
  the guardrail text extractor (`lib/safeguarding/itemText.ts`), and scoring only
  indirectly (a stimulus is never scored).

**The sample, 12 teacher PDFs** (`docs/scripts/stimulus-scan.py design-tool/samples`;
50 pages, 211 numbered items detected, 42 raster figures, 0 vector figures; attribution
spot-checked by hand on Unit 0, Unit 1, Graphing Skills, Solubility).

| Pattern | Figures | Where |
|---|---|---|
| Figure followed by exactly one item | 13 | Graphing 1–8; Unit 0 items 1, 2, 3, 6 |
| Figure shared by two or more items | 14 | Solubility curve → 1–6 on each form; Unit 1 graph → 13–15; Unit 0 → 4–5; Graphing → 9–10; ERAS ×8 |
| Figure after an item (answer grid, table to fill) | 11 | Graphing 11's blank grid; Unit 1 item 15's table; Unit 0 item 8 |
| Decorative / orphan | 4 | headers, cover art |
| Figures ≥35% of page height | 2 | Graphing's blank grid (79%, a drawing target, not a stimulus); one Unit 0 diagram (37%) |
| "questions 4–6" / "use the graph above" phrasing | 0 | none in 50 pages |
| Two-column pages | 3 | Flinn ×2 (choice grid), Solubility ×1 (matching bank) |
| Two forms per page | 7 pages | Solubility, Boyle's, Combined Gas Law (E9) |

Passage counts (95 long text blocks) are excluded from the conclusions: long stems
and essay prompts look like passages to a regex, and ERAS alone contributes 50.

**What the sample says.**

1. Both patterns are common. A per-item field covers 13 of the 27 real stimulus
   figures and would force the other 14 to be duplicated onto every item that uses
   them. An item-set covers all 27, and a set of one *is* the per-item case.
2. Stimuli are small. Only two figures exceed a third of a page and one of those is a
   drawing target. Figure-above-group on one scrolling screen is the normal case;
   "its own page" is an option a teacher sets on one stimulus, not a rule.
3. Pairing is by adjacency. No PDF says "use the graph above". Extraction has to
   infer "the figure immediately above, until the next figure" and the teacher has to
   confirm the pairing before Add. The positional rule was right in every spot-checked
   case except a second form restarting at item 1 on the same page (E9's problem).
4. Two-column and two-form layouts are extraction problems (E1, E9), not stimulus-model
   problems.

## Shape (proposed)

**Item set = one stimulus + an ordered list of one or more items.** An item outside
any set behaves exactly as today. The editor never shows the word "set": attaching a
figure or passage to a question creates a set of one; dragging a second question under
the same stimulus grows it.

- **Schema.** New table `item_sets` (`id`, `assessment_id` cascade, `position`,
  `stimulus_text` — KaTeX + `![alt](asset:uuid)` refs like a stem, `layout`
  `'inline' | 'own_page'` default `inline`, timestamps). `items.item_set_id` nullable
  FK, `SET NULL` on delete so deleting a set frees its items rather than deleting
  them. Ordering: sets take a position in the assessment order; items inside a set
  keep their own `position` relative to each other.
- **Images.** A stimulus's figures are ordinary assets referenced from
  `stimulus_text`, so export, import, sharing (slice C), and the guardrail text path
  need no new plumbing beyond reading one more field.
- **Wire formats (ADR 0016 grows).** Export bundle: `item_sets: [{id, stimulus,
  layout, item_ids}]` alongside `items`; older bundles without the key import
  unchanged. Delivery bundle: the same, minus nothing — a stimulus is student-facing
  by definition. Both schemas in `@secure-test/schema`.
- **Delivery and layout (client).** `inline`: stimulus rendered once, pinned above
  the group, group scrolls beneath. `own_page`: the stimulus is a page of its own and
  each item page repeats a collapsed reference to it. The client's per-item layout
  becomes per-set; an item with no set is a set of one with no stimulus.
- **Editor.** "Add stimulus above" on any question; the stimulus editor is the same
  stem editor (math, images). Readiness: a set with no items is a gap; an empty
  stimulus is a gap.
- **Extraction.** Per page: extract embedded images (spike S1) and page text runs
  with positions; the model receives the page's text with `[FIGURE n]` markers at
  their vertical positions and is asked to return items *and* `stimulus_for:
  [item indices]` per figure/passage. The import panel shows each proposed set as a
  card (stimulus thumbnail + its items) with a "split" and "merge" control so the
  teacher confirms pairing before Add. Adjacency default, never silent.
- **Print/preview.** Stimulus renders once above its group; `own_page` forces a page
  break.

## What this is not (non-goals for the first cut)

- Not a per-student stimulus (E12 builds on this later).
- Not a shared stimulus library across assessments.
- Not a table item type (E3) or rich text (E6); both compose with this later.
- Not OCR of figures into text; the figure ships as an image.
- Not a change to scoring.

## Spikes before the schema is touched

- **S1 — embedded image extraction from text-layer PDFs.** Can unpdf (or PyMuPDF via
  a Python helper, ADR pending) return each figure's bytes and bbox reliably across
  the sample? Success: ≥40 of the 42 figures recovered at legible resolution with
  correct page position. If it fails, fallback S2.
- **S2 — page rasterization + Bedrock region proposal.** Render the page, ask the
  model for figure regions and owning items. Cost and latency per page measured.
- **S3 — font runs for E6.** unpdf style-per-run fidelity on the same sample, since
  E5's extractor rework is the moment to carry emphasis through.

Each spike is a throwaway under `docs/scripts` plus a findings paragraph here.

**S1 — RAN 2026-09-01 evening, PASSED** (`docs/scripts/stimulus-images-spike.ts`,
unpdf 1.6.2 / pdf.js, no Python). Walking each page's operator list with a CTM stack
(save/restore/transform/form-XObject begin+end) gives every image paint's bbox in
viewport space, and `extractImages` gives its pixels. Against the PyMuPDF baseline
(42 rects >40 pt): **41 unique placements, 41 found, 41 with pixels, all matched at
IoU ≥ 0.5** — the 42nd baseline entry is a PyMuPDF double count (ERAS page 1 lists
xrefs 15 and 17 at the identical rect; `get_image_info` draws only 17 there), so
the recovery rate is 41 of 41, above the 40-of-42 bar. Effective resolution
(72 × px/pt): min 91 dpi (a Flinn answer box), median 186, max 641; spot-checked
PNGs (Solubility curve 152 dpi, Graphing bar chart 251 dpi) are fully legible.
All 41 are plain image XObjects — no inline images, image masks, or repeats in this
sample. Rotated pages: none in the sample; the viewport transform handles them in
principle, untested. → **The Python helper is not needed; decision 4.4 closes as
"unpdf only".** S2 is not needed.

**S3 — RAN the same evening** (`docs/scripts/stimulus-fontruns-spike.ts`). After
`getOperatorList()` (fonts resolve into `page.commonObjs` only then — before that,
`get` throws "isn't resolved yet"), each text item's font object carries pdf.js's
`bold` / `italic` flags and the BaseFont name (`CAAAAA+Arial-BoldMT`): Unit 1's
**ABIOTIC** is a bold run, as are the item-7 instructions and the A)–D) labels, so
E6 can carry bold/italic from the text layer. **Underline is not a text property**
(a drawn path under the baseline) — E6 would need a path-near-baseline heuristic or
accept bold/italic only. Bonus for E7(a): Solubility's subscripts are separate runs
at 6.6 pt against an 11 pt body on the same line (`K`, `2`, `Cr`, `2`, `O`, `7`), so
the text layer alone can mark sub/superscripts deterministically before the model
ever sees the text — a cheaper, more reliable path than asking the model to guess.

## Teacher questions (asked during the pilot, James 2026-09-01 — not a gate)

Mom Test framing — about what they do today, no mockups first. Decision 4.5
below: a broad set of teachers during the pilot phase rather than three named
teachers before building, so slices 1–2 proceed on the proposed shape and the
answers refine `own_page` behaviour and the answer-space cases before slice 3.

1. When several questions share a graph or passage, do students see it once at the
   top or beside each question on paper? What happens on the second page?
2. How often is the figure the *answer space* (a grid to draw on, a table to fill)
   rather than the stimulus? (The sample says 11 of 42.)
3. Do they ever want the stimulus hidden until the student reaches it (own page), or
   is always-visible the expectation?

## Slices (sketch)

1. Schema + API + editor for item sets with a text-only stimulus; export/import round
   trip; sharing copies sets. No extraction yet.
2. Delivery bundle + Swift client `inline` layout; `own_page` behind the same flag.
3. Extraction pairing: `[FIGURE n]` markers, `stimulus_for`, import-panel set cards.
4. Image extraction (S1 or S2 winner) feeding slice 3.
5. Print/preview and readiness rows; manual-check rows for each.

E3, E7(b), and E12 attach after slice 2.

## Decisions (James, 2026-09-01)

- [x] **Item-set with sets-of-one** as the model (proposed above). A per-item field
      cannot share a passage across questions, and duplicating it per item defeats
      "see it once".
- [x] **`inline` default with `own_page` per stimulus.** A two-page passage and a
      small figure in the same test need different treatment; a global rule cannot
      serve both.
- [x] **Stimulus is student-facing always** (ships in the delivery bundle) —
      confirmed (a stimulus is never scored, so ADR 0016's key concern does not apply).
- [x] Python helper for image extraction — **NOT NEEDED**: S1 ran the same evening on
      unpdf/pdf.js alone and recovered 41 of 41 real figures with position and pixels
      (see the spike findings above). ADR 0013's pure-JS stance holds.
- [x] Which teachers to ask, and when — **a broad set during the pilot phase**, not a
      gate before building (heading above).

Spikes S1 + S3 done 2026-09-01 evening (findings above).

## Slice 1 — BUILT 2026-09-01 evening (James's answers: contiguity; auto-delete; locked after publish; preview included)

- **Schema, migration 0025** (`item_sets`: id, assessment_id cascade, stimulus_text,
  layout inline|own_page with a CHECK, timestamps; `items.item_set_id` SET NULL on
  delete). Applied to the local dev + test DBs; Aurora after the next deploy via
  `migrate-aurora.sh`.
- **Ordering by contiguity, no set position.** A set's items must be one block in
  `items.position` order and the set sits where its first item sits; the reorder route
  refuses an order that splits a set (`reorder_would_split_set`). Preview, delivery and
  the client keep ordering by item position.
- **API** (`lib/api/itemSets.ts` + `app/api/assessments/[id]/item-sets/…`): create from
  adjacent items, PATCH text/layout, DELETE (frees the items), attach the neighbour just
  before/after the block, detach an end item (a middle one is `would_split_set`); the
  last detach and the delete of a set's last item auto-delete the set. Draft-only —
  locked after publish like stems. The items list carries `item_sets` and each item its
  `item_set_id`.
- **Wire formats** (`@secure-test/schema`): `ItemSetSchema` {id, stimulus, layout,
  item_ids}; `item_sets` optional on BOTH bundles with a shared cross-check (items exist,
  one set each, contiguous). Export emits sets ordered by first item (omitted when none —
  older bundles byte-stable); import recreates them on the copy with remapped item ids
  and stimulus asset refs; sharing copies sets for free; delivery carries them (decision
  4.3). Stimulus `asset:` refs are bundled like stem refs.
- **Preview / print**: the stimulus renders once above its first item, labelled
  "Questions N–M"; `own_page` = a page break in print; empty text is flagged.
- **Editor**: stimulus card above the first question of a set (stem editor: text, image
  picker, math translator, live preview; layout select; Save; Remove), per-question
  "Add stimulus above" / "Join stimulus above" / "Detach from stimulus", questions of a
  set indented; Move up/down moves a set as one block. Readiness: "Stimulus for question
  N is empty".
- **Tests**: `test/item-sets-api.test.ts` (13), plus item-set cases in the schema
  package, items-api export, import-api, delivery-api, preview-render and item-readiness.
- **Not in this slice**: client rendering of `item_sets` (slice 2 — Swift's synthesized
  `Decodable` ignores the new key meanwhile), extraction pairing (slice 3), image
  extraction into the import panel (slice 4). Hand-run rows 23–29 in
  `docs/design-tool-manual-checks.md`.

## Slice 2 — BUILT 2026-09-01 night (client renders item sets)

- `DeliveryBundle.itemSets` (`ItemSet` {id, stimulus, layout, itemIds}; absent → `[]`;
  an unknown layout decodes as `inline` rather than failing the bundle).
- `AssessmentPage` renderer: `BUNDLE.item_sets` → a `section.stimulus` block once,
  before the set's first member, labelled "Questions N–M" / "Question N", body through
  `textWithAssets` (text nodes + inline images, never markup); members get
  `.item.in-set` (indented). Ids not in the bundle are ignored; a set with no known
  members renders nothing. **`own_page` renders like `inline`**: the client is one
  scrolling page (James, 2026-09-01: MVP shape; per-question paging added to the
  roadmap in `docs/plan.md`), so the flag has nothing to attach to yet.
- Fixture: `design-tool/scripts/generate-delivery-fixture.ts` seeds one `own_page`
  set over positions 2–3 with the image ref, so `DeliveryBundleTests` decodes real
  route bytes and `RendererStimulusTests` (JavaScriptCore harness) proves placement,
  label, image, member marking, no-sets, unknown-layout and unknown-id behaviour.
- File → Open (offline bundles) uses the same page — nothing extra.
- Hand-run rows in `client/MANUAL-CHECKS.md` ("E5 slice 2").
- **Found on the way, fixed the same night:** the shipping client rendered no math —
  stems and stimuli showed raw `$…$` (PoC-B inlined KaTeX per ADR 0009; the Phase 5
  page reserved the CSP for it but never carried it over). Ported: ADR 0009 addendum.

## Slice 4 — BUILT 2026-09-01 night (figures + markers out of the text layer; built before slice 3 because the markers feed it)

James's answers: figures ride the extraction response as data URLs and become
assets only when a set is added (extraction stays write-free); every figure above
40 pt is shown, decoration and all, with the teacher deciding.

- `lib/pdfImport/extractFigures.ts` (`extractPdfLayout`): the S1 walk — operator
  list + transform stack per page, image paints → page-space bbox (top-left origin),
  pixels via `extractImages`, PNG via `lib/pdfImport/png.ts` (no native deps) — plus
  the page text rebuilt from positioned runs (lines by baseline, left to right) with
  `[FIGURE n]` on its own line at each figure's top. Figures are numbered in document
  order. Limits: 40 pt minimum side, 2 MiB per figure, 12 MiB per response, 60
  figures; an over-limit figure keeps its position with `omitted` set.
- Route: on the text path the model (and the E8 numbering walk, and the guardrail's
  input stage) reads the marked text; the response carries `figures` +
  `figure_count`. Scanned PDFs: no figures (no text layer to walk; rasterising a page
  would need a canvas the server does not have). A failing figure walk falls back to
  the flat text rather than failing the import.
- Panel: a "N figures found in the PDF" strip with thumbnails and page numbers —
  visible on its own until slice 3 turns them into set cards.
- Tests: `test/pdf-figures.test.ts` (PNG encoder incl. gray+alpha; marker
  interleaving; a hand-built PDF with an uncompressed 2×2 RGB image XObject —
  bbox [100,142,220,232], pixels "ABCDEF…" round-trip through the PNG, marker between
  lines 5 and 6; no figures / decoration-sized image; the three limits) and a route
  test (figure on the text path, none scanned). `test/helpers/pdf.ts` now holds the
  PDF builders both suites use.

## Slice 3 — BUILT 2026-09-01 night (pairing + set cards)

James's answers: model-proposed pairing with the adjacency rule as the fallback; every
pairing confirmed by the teacher in the panel before anything is written.

- **Model contract** (`lib/pdfImport/extractCore.ts`): the prompt explains the
  `[FIGURE n]` markers and asks for `{"items":[…],"item_sets":[{"stimulus","figures",
  "item_indexes"}]}` when questions share a figure or passage (a bare array still means
  "nothing shared"). `parsePdfExtraction` accepts both shapes; the Bedrock and mock
  providers return `proposed_sets` (mock: `SET: #a-b | figure=n | text` segments).
- **Validation** (`validateProposedSets`): indexes remapped from raw to validated
  candidates (a rejected candidate just leaves its set), one set per question (first
  wins), a set kept as its first consecutive run (the rest reported `not_contiguous`),
  figure numbers bounded, stimulus text bounded. **Adjacency fallback**
  (`questionAfterFigure` + `adjacencyFallback`): a figure the model did not place goes
  on the first numbered question printed below its marker (markers in between are
  skipped, so stacked figures share a set); figures with no question below stay in the
  strip. Sets carry `source: "model" | "adjacency"` so the panel can say "paired by
  position, please check".
- **Route**: `proposed_sets` + `rejected_sets` in the response; proposed stimuli join
  the guardrail's output-stage scan.
- **Panel**: set cards in document order — figure thumbnails, editable stimulus text,
  the member questions indented; Split off the last question / Include the next /
  Merge with the stimulus above / Discard a figure / Drop the stimulus; "Add a
  stimulus" on a plain candidate makes a set of one. **Add** uploads each figure
  through `/api/uploads/image` (assets only now — extraction wrote nothing; per-owner
  hash dedupe), posts the questions in order, then `POST item-sets` with the image refs
  + text as the stimulus. Add all walks document order so a set's questions stay
  adjacent. A failure after the questions posted says "questions added but not
  grouped".
- **Found on the way**: one stray unescaped quote inside a stem ("…the question, "How
  does…") failed the whole Graphing Skills import. `repairModelJson` now runs only
  after the strict parse fails and fixes what strict JSON can never contain (a lone
  backslash before a non-escape char, a quote not followed by `, } ] :`); the prompt
  also asks for escaping. Known limit: a content quote right before a comma.
- **Tests**: parser shapes + repair, set validation (remap, exclusivity, contiguity,
  bounds, junk), adjacency lookup incl. stacked markers, mock SET segments, a route test
  with a rejected candidate + a model set + a fallback figure. Hand-run rows 32–36 in
  `docs/design-tool-manual-checks.md`.
- **Bedrock evidence** (sample PDFs, temperature 0): Unit 0 — 7 figures, 7 model sets,
  every figure placed with its passage text (fig 7 → the five chi-square parts, fig 6 →
  the two trichome questions); Unit 1 — the graph → questions 13–14, the table image →
  15, as the scan's hand check had it; Solubility — the curve on each of the four forms
  → that form's six questions. Graphing Skills (after the repair) — 13 figures, 11
  questions, 11 model sets: figures 1–10 one per question 1–10 (the scan had 9–10 as a
  shared pair; the model split them — the teacher's Merge covers it) and figures 11–13
  (the blank answer grids, which the scan classed as answer space) on question 11 —
  exactly the case "show all + Discard" was chosen for.

