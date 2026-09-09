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
built in the same session (see the commit). Nothing else built.
