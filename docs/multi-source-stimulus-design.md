# Multi-source stimulus — several labelled sources on one question

Design note, 2026-09-09. Written from the first pilot assessment: an AP
Seminar-style free-response document — one 90-minute essay prompt followed by
four sources (a poem, a two-page article, an excerpt with three charts, a
speech excerpt). Decisions marked **D-n** are James's (2026-09-09) and are
listed at the end; **§Progress says what is built**. High priority: this is
the initial pilot assessment.

## What the import did with it (measured 2026-09-09)

The document went through the real pipeline (`samples/_run-import.ts`,
Bedrock Sonnet 4.6 — the same code as `POST …/items/import-pdf`): 9 pages,
15k chars of text layer, **one `essay` candidate, no item set, no figures**.
The question text and type were right; every source was dropped. Three
separate causes:

1. **The charts are vector drawings.** `extractPdfLayout` records image
   XObject paints only (`paintImageXObject` / `…Repeat`); the 12-PDF sample
   had 0 vector figures so that was enough then. The three OECD charts are
   paths → `figures: []`, and their axis labels and country names land in the
   page text as noise lines.
2. **The prompt does not describe this document.** It frames a stimulus as
   "a passage or data given before" questions that "share" it. Here there is
   one question, the sources come *after* the prompt, and the model would have
   to reproduce ~13.5k characters verbatim in its output. It silently returned
   a bare array.
3. **Even a perfect import would be unusable.** A set has one
   `stimulus_text`; four sources would be one 13.5k-char block. Neither the
   client nor the teacher preview keeps line breaks (no `white-space` rule on
   `.stem` or `.stimulus-body` on either surface, so a poem collapses into
   prose), there is no way to move between sources, and under `own_page` the
   question page hides the whole block behind one "Show the passage"
   disclosure. Not workable for a synthesis essay.

Also seen: the "TIME — 90 MINUTES" heading comes out of the text layer as
`TI0E ǵ  0INUTES` (a symbol-encoded heading font) — cosmetic, the model
ignored it.

## What exists that this stands on

- **Item sets (E5, `docs/stimulus-design.md`).** `item_sets` (`stimulus_text`,
  `layout inline|own_page` with a CHECK, `source_item_id` for E12);
  `items.item_set_id`; contiguity rule; `ItemSetSchema {id, stimulus, layout,
  item_ids}` on BOTH wire formats (`packages/schema/src/items.ts`);
  `exportItemSets` (`lib/api/itemSetsBundle.ts`) feeds export and delivery;
  import recreates sets with remapped ids and asset refs; the editor's
  stimulus card (`AssessmentEditor.tsx` ~1760) edits text + layout; the
  preview renders the block once above the set (`renderHtml.ts` ~387).
- **Client paging (`docs/client-paging-design.md`).** `inline` = one page
  with the stimulus on top; `own_page` = a passage page ("Passage for
  question N", jump button `P`) then one page per member with a
  `<details class="passage-ref">` "Show the passage" disclosure. The passage
  block is ONE element moved between pages (`AssessmentPage.swift` ~2540).
  The client is fullscreen by default (batch 4, S-8) and `contentMinSize` is
  720×620.
- **Text rendering.** `textWithAssets` (client) and `renderItemContent`
  (teacher) emit text nodes with E6 `**bold**` / `_italic_`, KaTeX, and
  `![alt](asset:uuid)` images. No block structure; newlines are ordinary
  whitespace.
- **Import extraction.** `extractPdfLayout` walks each page's operator list
  with a CTM stack, records image paints, splices `[FIGURE n]` markers into
  positioned text lines; the model returns `{"items":[…],"item_sets":[…]}`;
  `validateProposedSets` bounds the stimulus at 20 000 chars;
  `adjacencyFallback` pairs unplaced figures. The panel shows set cards and
  Add uploads figures through `/api/uploads/image`.
- **unpdf** ships `renderPageAsImage(data, page, {canvasImport, scale})`,
  which needs `@napi-rs/canvas` (not installed). The Fargate image is
  `node:22-slim` on ARM64, `output: "standalone"`; a native package must be
  traced into the standalone output.

## Options considered

| | Shape | Teacher | Student | Verdict |
|---|---|---|---|---|
| A | Keep one stimulus; headings + line breaks | one long box | one long scroll, no navigation | too little |
| **B** | **the set carries `sources: [{label, text}]`; client shows source tabs; a third layout `side_by_side`** | import proposes A–D pre-labelled; editor lists sources | tabs beside the answer box, each source scrolls on its own | **chosen (D-1, D-2)** |
| C | sources as their own item type | clutters the question list | sources read as questions; scoring must skip them | wrong model |

## Proposed shape

**Schema (migration 0030).** `item_sets.sources jsonb not null default '[]'`
— an ordered list of `{label: string, text: string}` (D-1: a JSON column, not
a child table; a source has no identity of its own outside its set and is
never referenced by anything). `stimulus_text` stays and becomes the
*introduction* (the framing paragraph, or empty). Layout gains
`'side_by_side'` (D-2: an explicit third value the teacher picks; the CHECK
and `ITEM_SET_LAYOUTS` widen). Bounds: label 1–80 chars, text ≤ 20 000
chars (the existing stimulus bound), at most 12 sources.

**Wire formats (`@secure-test/schema`).** `ItemSetSchema` gains
`sources: z.array({label, text}).max(12).default([])` and the layout enum
the third value. Both bundles carry it — a source is student-facing by
definition (the E5 decision). Older bundles without the key import with
`sources: []`. Source text takes asset refs like a stem, so figures inside a
source ride the existing asset bundling. The Swift `ItemSet` decodes
`sources` (absent → `[]`) and an unknown layout still falls back to
`inline`.

**API.** `PATCH …/item-sets/:setId` accepts `sources` whole (replace, like
`stimulus_text`); create accepts it too. Draft-only, locked after publish.
Readiness: a source with an empty text is a gap ("Source B for question 1 is
empty"); a set whose members include no essay/short-text is not a gap
(sources on a multiple-choice set are fine).

**Editor.** The stimulus card grows a "Sources" list under the introduction:
each row = label field + the same stem editor (text, image picker, math,
emphasis, live preview), Move up/down, Remove; "Add a source" appends with
the next letter as its default label ("Source E"). The layout select gains
"Side by side (sources beside the question)".

**Preview / print.** Introduction, then each source as a labelled block
(`<section class="source" aria-labelledby=…>`, `<h3>` = the label) in
order, then the questions; `side_by_side` prints like `own_page` (a page
break before the set) — print has no side-by-side.

**Client.**
- A set with ≥1 source renders a **source pane**: the introduction on top,
  then a `role="tablist"` of the labels (Left/Right arrow moves between
  tabs, Home/End to first/last, roving tabindex — same pattern as the math
  keypad), one `role="tabpanel"` per source that scrolls inside a fixed
  height. A set with exactly one source shows it without a tab strip.
  Bold/italic, KaTeX and images render as in a stem.
- `side_by_side`: the question page is two columns — the source pane left,
  the member(s) right — when the viewport is ≥ 1100 px wide; narrower falls
  back to `own_page` behaviour (a passage page carrying the pane, then the
  question with a "Show the sources" disclosure). Under `inline` the pane
  sits above the members as today; under `own_page` it is the passage page.
- Line breaks: `white-space: pre-line` on `.stem` and `.stimulus-body` so a
  poem stays a poem (slice 1, both surfaces).
- Accommodations apply unchanged: the pane is ordinary page content, so
  contrast sets, Atkinson, zoom (batch 4) all reach it; the tab strip uses
  the token colours.
- Accessibility: tabs are native `<button>`s with `aria-selected` and
  `aria-controls`; each panel has `aria-labelledby` its tab; the pane's
  scroll region is focusable (`tabindex="0"`) so keyboard users can scroll
  the source. A chart is an `<img>` whose `alt` is the printed caption
  (the caption stays in the text as well — the text layer already has it);
  VoiceOver reads the caption, not the picture.

**Import.**
- Prompt: (a) an item set may hold a single question; (b) sources may be
  printed *after* the question they serve; (c) when the document labels its
  sources ("Source A", "Passage 1", "Document 2", an author line under a
  heading), return them as `"sources":[{"label","text"}]` on the set with
  each source's full printed text, verbatim, in document order, and the
  framing text (if any) as `stimulus`; (d) chart / figure labels, axis
  values and legend text belong to the figure, never to a source's text.
- Validation: `validateProposedSets` reads `sources`, bounds each (label
  80, text 20 000, 12 sources), drops empty ones; a set with sources and no
  figure and no stimulus is not `empty`.
- **Shortened-source check** (the model tends to abbreviate long verbatim
  text): for each returned source whose label appears as a line in the
  marked text, take the span from that heading line to the next source
  heading (or the end of the document) and compare lengths after whitespace
  folding; a returned text under 85 % of the span is flagged
  `shortened: true` on the panel card ("Source B looks shorter than the
  document — check it"). The teacher can paste from the PDF; the check
  never rewrites what the model returned.
- Panel: a set card lists its sources (label, first line, length, the
  shortened flag) above the member questions; "Add" posts them with the set.
  The single-essay-plus-sources case gets the layout default
  `side_by_side` on the card (the teacher can change it before Add); sets
  without sources keep `inline`.

**Vector figures (D-3: server canvas).**
- In the operator walk, also track path painting: `constructPath` ops
  (pdf.js batches `moveTo`/`lineTo`/`curveTo`/`rectangle` into one op with
  the point list) followed by `stroke` / `fill` / `eoFill` / `fillStroke` —
  map the path's points through the CTM to a page-space bbox. Clip paths
  and the `rectangle` a page background uses are excluded by size
  (≥ 90 % of the page) and by having no paint op.
- Cluster path bboxes on a page: union any two whose bboxes are within 12
  pt of each other, repeat until stable; keep clusters at least
  `MIN_FIGURE_PT` on both sides and with at least 8 painted paths (a rule
  under a heading or an underline is 1–2 paths and stays text). Text runs
  whose baseline falls inside a cluster bbox are dropped from the page
  text (axis labels, legend entries) — so the source text stops carrying
  chart noise — and the cluster's *title* line (the nearest bold text line
  above it, within 24 pt) stays in the text as the caption and becomes the
  figure's `alt`.
- Rasterise: `renderPageAsImage(doc, p, {scale: 2, canvasImport: () =>
  import("@napi-rs/canvas")})` once per page that has a cluster, then crop
  the cluster's bbox (scaled) with the same canvas and encode PNG (the
  canvas gives `toBuffer("image/png")`; `lib/pdfImport/png.ts` stays for the
  raster path). The result is an ordinary `PdfFigure` (`n`, `page`, `bbox`,
  `data_url`, `source: "vector"`) — it rides the same `[FIGURE n]` markers,
  limits, adjacency fallback, panel strip and Add; the teacher sees nothing
  new.
- **Spike S4 before the slice:** `@napi-rs/canvas` (linux-arm64-gnu
  prebuilt) inside the standalone container built by `design-tool/Dockerfile`
  (`serverExternalPackages` + tracing so the `.node` binary lands in the
  image), `renderPageAsImage` on the AP PDF's page 10 at scale 2, and the
  three charts cropped legibly. Go / no-go in §Progress. If no-go: the
  fallback is a browser-side crop tool in the panel (render the page with
  pdf.js in the teacher's browser, drag a rectangle, upload as a figure) —
  which would also close E13's `needs_figure` for scans.

## Non-goals

- Not a shared source library across assessments.
- Not per-source questions ("Question 3 is about Source B"): a source is
  visible to every member of its set.
- Not rich structure inside a source beyond E6 emphasis, KaTeX, images and
  line breaks; headings inside an article stay as bold lines.
- Not OCR of charts into text.
- Not a change to scoring or to E12.

## Slices

1. **Line breaks** (XS, both surfaces): `white-space: pre-line` on `.stem`
   and `.stimulus-body` in the client CSS, the preview / print CSS, and the
   editor's live preview. Tests assert the rule ships. Independent of the
   rest; ships with the next client release and deploy.
2. **Schema + API + editor + preview** (M, design tool): migration 0030,
   `sources` on both wire formats, `side_by_side`, export/import round trip
   (sharing copies sources), the editor's source list, preview blocks,
   readiness. Tests in `item-sets-api`, the schema package, export/import,
   delivery, preview-render, readiness.
3. **Import** (S–M, design tool): prompt, validation, shortened-source
   check, panel card. Bedrock evidence on the AP PDF: four sources, all
   ≥ 85 % of their spans, `side_by_side` proposed.
4. **Client** (M): `sources` decode, the source pane with tabs, the
   `side_by_side` page, fallbacks, accommodations, tests in the JSC harness
   (placement, tab keyboard model, single-source, narrow fallback) and
   `DeliveryBundleTests` on a regenerated fixture with a sourced set.
5. **Vector figures** (S4 spike, then M): the path walk and clustering
   with unit tests on a hand-built PDF (`test/helpers/pdf.ts` gains a path
   builder), rasterise + crop, Docker change, Bedrock evidence on the AP
   PDF (three charts as figures under Source C, chart noise gone from the
   source text).
6. **Rows**: teacher rows in `docs/design-tool-manual-checks.md` (import
   the AP PDF → four sources + three charts + one essay; edit a source;
   preview; export/import; publish) and client rows in
   `client/MANUAL-CHECKS.md` (tabs by mouse and keyboard, VoiceOver reads
   the tab and panel, side-by-side on the fullscreen client, the narrow
   fallback, zoom + contrast sets, resume keeps the open tab irrelevant —
   the essay text restores).

Order: 1 now; 2 → 3 (design tool, one terminal) ∥ 4 (client, after 2's
schema lands so the fixture regenerates once); 5 after 3 (its output feeds
the same panel); 6 with a sitting.

## Decisions (James, 2026-09-09)

- **D-1** Sources are a JSON column on `item_sets`, not a child table.
- **D-2** `side_by_side` is an explicit third layout the teacher picks, not
  inferred from the source count.
- **D-3** Vector charts are rasterised on the server with `@napi-rs/canvas`
  (spike S4 first); the browser crop tool is the fallback only.
- **D-4** Slice 1 (line breaks) ships now as its own commit.
- **D-5** Priority: now, ahead of the queued 4b / 4c rows and the gradebook
  CSV — this is the initial pilot assessment.
- **D-6** (slice 4, accepted in review 2026-09-09) The `side_by_side`
  width is read ONCE at build time, not on resize: re-paging would rebuild
  the item tree and drop uncommitted essay text and live drawing strokes.
  A CSS media query stacks the two columns if the window is dragged
  smaller afterwards; the client is fullscreen by default (batch 4, S-8).

## Open questions

- Width threshold for side-by-side (1100 px proposed) — confirm on the
  fullscreen client at zoom 150 %.
- Should the tab strip remember the open source across page turns within a
  set? (Proposed: yes, in memory only — nothing posts.)
- Label detection beyond "Source X" / "Passage N" / "Document N" — the
  shortened-source check depends on finding the heading line; documents with
  unlabelled sources get the model's labels and no check.

## Progress

2026-09-09: this note written; decisions D-1…D-5 made the same day. Slice 1
built in the same session (`d20eeb9`).

2026-09-09, later: **slice 2 BUILT** (Opus 5 agent from this note, diff
reviewed and every check re-run in the main session). Migration **0030**
(`sources jsonb not null default '[]'`, the layout CHECK widened to
`side_by_side`) applied to the local dev + test DBs — **Aurora needs
`migrate-aurora.sh` after the next deploy**. `StimulusSourceSchema`
`{label 1–80 trimmed, text ≤ 20 000}` × ≤ 12 on `ItemSetSchema.sources`
(default `[]`, so a pre-slice bundle imports unchanged and every exported
set now carries the key); create + PATCH take `sources` whole; export /
delivery / preview scan source texts for `asset:` refs and import remaps
them; the preview renders one `<section class="source">` per source with
`pre-line`, `side_by_side` prints like `own_page`; readiness: the
empty-stimulus gap needs intro AND sources empty, an empty source is
`Source "B" for question N is empty`; the editor's stimulus card has the
Sources list (label, the same content editor as the introduction, Move,
Remove, "Add a source" → next letter) and the third layout option; the
results page and scoring queue stems got `whitespace-pre-line` (the slice 1
fold). Schema package 114 → 121 tests, design-tool 1327 → 1345, typecheck
clean. Not deployed.

2026-09-09, later still: **slice 3 BUILT** (Opus 5 agent, diff reviewed +
checks re-run in the main session, one addition made here). Prompt rules
(a)–(e) added to `PDF_EXTRACT_SYSTEM_PROMPT` (single-question sets, sources
printed after the prompt, labelled sources returned verbatim as `sources`,
chart text belongs to the figure) and a short form on the scanned prompt;
`validateProposedSets` reads `sources` (bare strings coerced to "Source
<letter>", label 80 / text 20 000 / 12 with `sources_truncated`), a set
with sources only is not `empty`, `ProposedSet.layout` defaults to
`side_by_side` when a set has sources; `flagShortenedSources` +
`sourceSpanLengths` compare each returned source with the document's span
under its heading line (forward search past the prompt's own mention of
the label, `[FIGURE n]` lines out, **and running headers / footers that
repeat on ≥ 3 pages out — added in review, with a trailing page number
ignored — because the first evidence run flagged the pilot's Source C on
furniture alone**); the route runs it on the text path and feeds source
texts to the guardrail output scan; the mock's `SET:` segment takes a
`| sources=Label::text;;Label::text` tail; the panel card lists sources
(label input, collapsed first line + character count, expand to edit —
editing clears the badge, Remove, "Looks shorter than the document —
check it"), a layout select with the editor's wording, and Add posts
`sources` + `layout`. design-tool 1345 → 1357 tests, typecheck clean.

**Bedrock evidence on the pilot document** (Sonnet 4.6, temperature as the
route sets it, one attempt — no prompt iteration was needed): 1 essay, 1
set, four sources A–D, `side_by_side`, `stimulus: ""`. With the furniture
filter:

| source | span chars | returned | ratio | shortened |
|---|---|---|---|---|
| A (poem) | 800 | 799 | 99.9 % | no |
| B (article) | 5 795 | 5 794 | 100 % | no |
| C (excerpt + charts) | 4 450 | 3 380 | 76 % | **yes** |
| D (speech) | 2 290 | 2 265 | 98.9 % | no |

Source C's flag is half right: the span still carries the three charts'
titles, axis captions and "Note." blocks (slice 5 moves the chart-internal
text into the figure and re-measures), but the model also dropped the
excerpt's footnote and citation line — real text the teacher should paste
back, which is exactly what the badge asks. The 85 % ratio stays.

2026-09-09, afternoon: **spike S4 RAN — GO (local half)**, then **slice 5
BUILT** (Opus 5 agent, diff reviewed + checks re-run in the main session).
Spike: `@napi-rs/canvas@1.0.9` + unpdf's `renderPageAsImage` renders a page
at scale 2 in ~50 ms after a 1.3 s warm-up, the cropped chart is legible;
the pilot's chart pages carry ~500 painted paths against 3 on a text page,
so path density separates charts cleanly. Measured: `constructPath` args
are `[paintOp, pathData, minMax]` with `minMax` in current user space (the
walk's CTM maps it, verified against the page-2 header rule and rendered
crops); it arrives as a typed array. Build: painted paths (paint ops
resolved by name through `OPS`; `endPath` / `clip` and page-size rects
skipped) clustered at 12 pt, kept at ≥ 8 paths and ≥ 40 pt each side; the
page rendered once per page with a cluster and each cluster cropped (+4 pt)
to PNG; `PdfFigure.source: "raster" | "vector"` + `caption` (the nearest
bold line above within 24 pt, joined with contiguous bold lines because
every pilot title wraps; raw font style, not the E6 page-majority guard,
because a title can be most of a page's characters; brackets stripped,
200 chars); text lines whose baseline sits inside a cluster leave the page
text; `MAX_PATHS_PER_PAGE = 4000` bounds the merge; a failing canvas import
or render drops vector figures with a warning and nothing else. Prompt: a
marker never goes into a stem or the introduction, but **inside a source's
text the model keeps each `[FIGURE n]` on its own line where the figure is
printed**; the panel counts source-placed figures into the set, uploads
each figure once, turns each kept marker into `![caption](asset:uuid)` at
Add, strips markers of discarded figures whole-line, and tags vector
figures "chart" in the strip. `next.config.ts`:
`serverExternalPackages: ["@napi-rs/canvas"]` (the `.node` binary is
traced, not bundled — the macOS build's standalone output carries it).
design-tool 1357 → 1366 tests, typecheck clean.

**Bedrock evidence on the pilot** (one run, 40 s): **4 vector figures, not
3 — page 6 carries two charts** (71 + 426 paths; pages 7 and 8 one each,
~490 paths); captions are the full two-line printed titles; Source C's
text carries all four markers on their own lines; the set lists
`figures: [1,2,3,4]`, `side_by_side`; sources A / B / C / D at 99.9 / 98.6 /
**93.5** / 96.4 % — none flagged. A crop written from the JSON is a
complete, legible chart. **Finding:** the pilot's axis labels, tick values
and country names are drawn as paths, not text, so the text-drop rule
removes nothing here (it fires on the hand-built fixture); Source C's
remaining gap is model variance plus the citation / footnote.

**Container half of S4 — GO, with one Dockerfile fix.** The builder stage
(`node:22-slim`, linux-arm64, glibc) rendered the pilot's three chart pages
and the crop byte-for-byte as macOS did (~50 ms a page). The runner image
carried the traced `.bun` store entries (`@napi-rs/canvas`, the
`linux-arm64-gnu` and `-musl` binaries) but **no
`design-tool/node_modules/@napi-rs/canvas` link** — Next's standalone
writes that link only for `next` — so `require("@napi-rs/canvas")` from the
route chunk failed and the extractor's guard would have hidden it as "no
vector figures" in production. Fix in `design-tool/Dockerfile`: the runner
stage copies bun's own `node_modules/@napi-rs` symlink directory from the
builder; verified in the rebuilt image from the route's directory as the
`node` user: the package loads, draws and encodes a PNG. **Open:** the
runner image has no system fonts, so a chart whose labels are real text
(not the pilot — its labels are paths) may rasterise without glyphs; add
`fonts-dejavu-core` to the runner stage if a hand-run shows blank labels.
Docker gotcha: colima shares `$HOME` only — a bind mount from `/private/tmp`
is silently empty inside the container.

2026-09-09, afternoon: **slice 4 BUILT in the second terminal and MERGED**
(`1a6d516` + `5fe50fb` on `claude/multi-source-client`, merged from `5fe50fb`;
`swift test` 529, `xcodebuild` green, both re-run in the main session).
`StimulusSource` decode (absent → `[]`, unknown layout still → inline);
the source pane under a set's introduction — several sources = a
`role="tablist"` with the keypad's roving-tabindex model (Left / Right
wrap, Home / End), one source = a labelled panel, panels focusable and
scrolling inside 60 vh, text through `textWithAssets`, `pre-line`, tokens
only, the open source kept in memory per set; `side_by_side` = one page
with the stimulus left (55 %) and every member right when the viewport is
≥ 1100 px at build, `own_page` behaviour below it with the disclosure
reading "Show the sources" (D-6 above); `layoutOf` is the single decision
point. Fixture: the position-4 essay becomes a `side_by_side` set with two
sources (a line break + bold, an asset ref); the generator needs
`DESIGN_TOOL_DELIVERY_SECRET`. 22 rows in `client/MANUAL-CHECKS.md`
("Multi-source stimulus — sources beside the question"), NOT run. Slices
1–5 are now all on `main`; slice 6 (rows) is what remains, after the
deploy + `migrate-aurora.sh` (0030) and a client rebuild.

2026-09-09 ~11:38 PT: **DEPLOYED — task definition rev 16, rollout
COMPLETED, `/api/health` 200 with `x-request-id`, `migrate-aurora.sh` OK
(Aurora at 0030).** James ran the deploy script by hand (the classifier
blocks `cdk deploy`); `cdk diff` beforehand showed the image and the
importer bundle only. Verified from the main session with
`describe-services` and a health probe. The origin now carries slices
2 / 3 / 5; the client rows need a rebuild (slice 4 is on `main`, not yet
released).

2026-09-09 ~13:00 PT: **slice 6 rows WRITTEN, none run** — teacher side
rows 79–92 in `docs/design-tool-manual-checks.md` ("Multi-source stimulus —
the import, the editor, the preview": the pilot import's 4 chart figures /
1 essay / 1 set with A–D, the card's sources + badge + layout, Discard a
figure then Add → refs inside Source C with the titles as alt, the editor's
Sources list incl. Move / Remove / Add + the readiness gap, preview + print,
export → import remap, publish → the client hand-off, two regressions);
client side the 22 rows from slice 4. Order: rows 79–90 on the origin
(Claude in Chrome, James's account), a client rebuild, then the client rows
on the same published fixture (`Multi-source hand-run 2026-09-09`).

2026-09-09 ~14:30 PT: **teacher rows 79–92 RUN on the origin** (Claude in
Chrome as James; results in `docs/design-tool-manual-checks.md`): **13 ✅,
row 90 half** (the delivery-bundle half waits for the client sitting). The
pilot import: 4 chart figures, 1 essay, 1 set with Sources A–D at 803 /
5730 / 4168 / 2214 chars, `side_by_side` proposed, no source flagged on
this run (C above the line — run-to-run variance against the 93.5 %
evidence run); Discard figure 2 + Add put three refs with the printed
titles as alt inside Source C and no leftover marker; the editor's Sources
list, Move, Remove, the readiness gap (`Source "Source D" for question 1
is empty` — a re-added source takes the next letter after the ones
present), preview + print, export → import all as designed. Two readings
worth keeping: the S3-backed `/api/assets` images take ~100–270 ms each,
so a DOM read right after the preview loads sees them 0 × 0 (they do
load); a same-owner re-import keeps the same asset ids (per-owner
content-hash dedupe), so the remap is only visible with a foreign id (the
unit test). The fixture **`Multi-source hand-run 2026-09-09` stays
Published on the origin** (paged, one essay, sources A–C, three charts in
C) for the 22 client rows; the scratch drafts (the re-import copy, the
raster regression) were deleted. The extraction took ~70 s on the origin.

2026-09-09 ~16:30 PT: **client sitting RUN — two passes** (James at the
rebuilt client on the origin, Claude on the teacher side; results in
`client/MANUAL-CHECKS.md`): pass 1 a REAL `AEAssessmentSession` on the
fixture, pass 2 a simulated one on a copy `Multi-source hand-run
2026-09-09 (accommodations)` (imported from the export, zoom / contrast /
font allowed, paged, published — a fresh assessment gives a fresh
attempt; both stay on the origin with their attempts). **18 of 22 rows ✅
or ✅-with-caveat; the two VoiceOver rows not run (C-3); two rows not
exercisable on the fixture.** Tabs, scrolling, keyboard, line breaks, the
charts inside Source C, answer safety, tab memory, the three
accommodations on the pane, stack-on-shrink, resume and hand-in all as
designed. Findings:

- **C-1 (HIGH — build next).** In the real session the page built with a
  narrow viewport and took the own_page fallback (passage page + the
  collapsed pane) even though the wire said `side_by_side`; the simulated
  session on the same Mac built wide and behaved. Cause: the AAC `begin()`
  transition is resizing the window at the moment the page builds, and
  D-6 reads the width once. Fix: evaluate `WIDE` on the first layout pass
  after the session is active (or re-evaluate once on `DID BEGIN` before
  the first paint), plus **a student toggle "Sources beside / above the
  question"** (James's ask) — and keep the passage page + collapsed pane
  presentation, which James found good on both pages.
- **C-2 (HIGH — the pilot document itself).** Source B's dollar amounts
  (`$57,600 … $30,000–$120,000`) were read as KaTeX delimiters and
  rendered as math (italic, odd spacing). Fix on BOTH renderers
  (`renderItemContent` / `renderLatex` and the client's auto-render
  pass): a `$` immediately followed by a digit never opens math; the
  importer prompt can also write currency as `\$`. Design-tool + client,
  S.
- **C-3.** VoiceOver's first-run Quick Start opens as another app and is
  invisible / unresponsive under AAC. Row setup: dismiss it once outside
  a session (Cmd-F5 → V). The two VoiceOver rows re-run next sitting.
- **C-4 (decision, James).** Students want to zoom a chart. Two parts:
  (a) `WKWebView.allowsMagnification` is off (the default) — there is no
  lockdown or integrity reason not to enable pinch-to-zoom (it never
  leaves the page; the peek captures the magnified view, which is fine;
  pointer mapping for drawing / drag already goes through
  `getBoundingClientRect`), bounded 1×–3× with a Reset in the Session
  menu (Cmd-0); (b) click-to-enlarge on an image inside a source or stem
  (an overlay, Esc to close) — easier than pinching precisely. Both S.
- **C-5 (rows + guide).** There is NO student accommodations toolbar; the
  three paint from the VALUE in the student's row (TIDE strings
  `1.5X` / `Reverse Contrast` / `On`), gated by the assessment's allowed
  list, and overrides are per assessment. The sitting guide said
  "toolbar" — corrected in the rows; the fixture recipe now says: allowed
  list on the assessment AND a per-student override on THAT assessment.
- **C-6 (design tool, S).** The assessment's Accommodations tab keeps the
  checkboxes ticked after navigating away without Save, so a teacher
  believes they stuck. Needs the stimulus card's "Unsaved changes" cue or
  autosave.
- **C-7 (dev, XS).** `client/scripts/launch-client.ts` does not forward
  `SECURE_TEST_NO_FULLSCREEN`; the narrow rows ran only because C-1 forced
  the fallback.

Order proposed: C-2 → C-1 → C-6 → C-4 (after the decision) → C-7 with the
next launcher touch. The next client release should carry C-1 and C-2.

**Decisions (James, 2026-09-09 evening):**
- **D-7** C-4: BOTH — pinch-to-zoom (`allowsMagnification`, 1×–3×, "Actual
  size" Cmd-0 in the Session menu) AND click-to-enlarge on images in stems
  and sources.
- **D-8** C-6: autosave the Accommodations tab (debounced PATCH per change
  with a saving / saved indicator), not an unsaved-changes cue.
- **D-9** C-7: fullscreen stays the way the app starts; the launcher
  pass-through is a dev-only convenience.
- Scheduling: roadmap row **S-f** — a fresh session, models and efforts
  per item there; C-2 and C-1 first; ships as client v1.2.0 plus one
  deploy.

**Row S-f progress:**
- **C-2 BUILT 2026-09-09.** Rule (James, 1.2): a single `$` opener whose
  next character is a digit is text and never opens math; `$$` display
  openers and `\$` escapes are unchanged. Design tool: both tokenizers
  (`lib/math/renderLatex.ts`, `lib/items/renderItemContent.ts` — still
  deliberate parallel copies); the importer prompt writes a dollar
  amount as `\$57,600` (the JSON-repair path already preserves `\$`,
  now pinned by a test). Client: `mathSegments` carries the same rule
  and the closing KaTeX pass is the renderer's own walk over it
  (`renderMathIn`, `katex.render` per math run, same options) —
  **auto-render is no longer inlined** (James, 1.1; the vendored file
  stays and is still tested); a side effect is that `\$` now reaches the
  student as a literal `$` on the client too (auto-render opened math on
  it). Escape hatch for math that starts with a digit: `${5x+3}$` or
  `$ 5x+3$` — one pre-existing renderer test (`$45\degree$`) was
  rewritten that way, and any authored stem in that shape renders as
  text until rewritten. Tests: design-tool 1379 (+13), client 539 (+10,
  `RendererMathPassTests` incl. the real vendored KaTeX in a JSContext
  through the harness's prelude). Rows: not yet written (rows slice next).
- **C-1 BUILT 2026-09-09.** Cause confirmed in code: `onBundleLoaded`
  begins lockdown BEFORE the controller loads the page, so the build
  always ran during the AAC `begin()` resize. Part 1: a Core
  `PageLoadGate` actor; the controller awaits it between the bundle
  fetch and `loadHostPage` (5 s backstop, James 2.1, logged either way;
  the "Loading your test…" notice is what shows meanwhile); the app opens
  it on every lockdown state except `.starting` (`.active`, and `.idle`
  = the settled aftermath of a failed / interrupted / ended begin), when
  `begin()` did not take, and at once on the offline path (no gate).
  `WIDE` is still read once at build — it now reads the settled width.
  Part 2: every side_by_side page carries a two-button group (James 2.2)
  "Sources: Beside the question | Above the question" (`role=group`,
  `aria-pressed`); "Above" adds `stacked` to the split, which is the
  media query's collapse applied on request; per set, in memory, survives
  page turns because the page DOM persists; narrow builds (own_page
  fallback) get no toggle and keep the passage page + disclosure. Tests:
  client 548 (+9: `PageLoadGateTests`, `RendererLayoutToggleTests`).
  NOT provable headlessly: that the deferred build reads the
  post-transition width — needs a real AAC session (rows slice).
- **C-6 BUILT 2026-09-09 (D-8).** The Accommodations tab autosaves:
  `lib/autosave.ts` is a small debounced single-flight primitive (600 ms,
  James 3.1; a change during a flight runs once more afterwards with the
  newest value; a failure shows in the status line and the next change
  retries; `flush()` on leaving the tab and on unmount); each toggle
  computes the next pair and schedules a PATCH carrying ONLY
  `allowed_accommodations` + `construct_altering`, so a half-typed
  Settings edit is never persisted by a tick, and the Settings tab's Save
  (kept, James 3.2) no longer sends the two sets — the tabs cannot
  overwrite each other. "Save accommodations" is gone; "Changes save
  automatically." + the existing status line replace it. Nothing
  schedules while the assessment is locked. No migration, no route
  change (the PATCH route already took a partial body and enforces the
  subset rule). Tests: design-tool 1386 (+7: `autosave.test.ts`, one
  PATCH-shape test). Teacher row: tick, navigate away, reload — still
  ticked (rows slice).
- **C-7 BUILT 2026-09-09 (D-9).** `client/scripts/launch-client.ts`
  forwards `SECURE_TEST_NO_FULLSCREEN` like the other knobs; the app's
  fullscreen default is untouched. No tests (the launcher has none).
- **C-4 BUILT 2026-09-09 (D-7, both parts).** Pinch: `allowsMagnification`
  on the assessment web view, clamped 1×–3× by a Core `ZoomLevel` (step
  ×1.25) — WKWebView has no gesture-ended callback, so a KVO observation
  on `magnification` pulls a pinch back inside the range after it
  settles; Session menu gains Actual Size ⌘0, Zoom In ⌘=, Zoom Out ⌘-
  (James 4.1), routed through the menu like ⌘E so they reach the host in
  a real session; enabled off the entry screen. Click-to-enlarge: every
  picture built by `textWithAssets` for a stem, a stimulus body or a
  source body is a focusable button (`enlargeable`, Enter / Space / click)
  opening one page-wide `role=dialog` overlay — the image at up to 80vh
  on a paper card, caption = "<source label> — <alt>" (James 4.2) or the
  alt alone, Close button; Esc (chained `document.onkeydown`, the order
  drag's own Escape still wraps it), Close, or a click anywhere dismiss
  and focus returns to the picture. The hotspot picture and the drawing
  prompt build their own `img` and are untouched; choices carry no
  images. Tests: client 568 (+20: `ZoomLevelTests`,
  `RendererImageOverlayTests`; the shim gained `document.body`). NOT
  provable headlessly: the pinch itself and whether KVO fires for it,
  ⌘0 / ⌘= / ⌘- inside a real session, magnification × the page's zoom
  accommodation, the scrim under the eight contrast sets, focus is not
  trapped in the dialog (Tab can leave it) — rows.

2026-09-09 ~18:50 PT: **PUSHED (`origin/main` = `09a0b65`) and DEPLOYED —
task definition rev 17, rollout COMPLETED, `/api/health` 200; no
migration (Aurora stays at 0030).** Run from the main session after James
re-logged in to SSO; `cdk diff` showed the container image only. The
origin now carries C-2 (server side) and C-6, so rows 93–108 can run.
The client is rebuilt from `09a0b65` (the four Row S-f markers are in the
dylib) for the client rows; v1.2.0 is NOT released yet.

**Hazard until slice 4 ships (now merged — stands until the next client
release):** the v1.1.0 client decodes `sources` as an
unknown key (dropped) and renders `side_by_side` as `inline`, so a set
published with sources before the next client release shows students the
introduction only. Slice 3 (import) needs no route change — the panel just
starts sending `sources` on `POST …/item-sets`. The Swift fixture
regeneration in slice 4 will add `sources: []` to every set once.
