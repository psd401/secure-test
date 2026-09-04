# PDF import — enhancement checklist

Source: the 2026-09-01 production sample run (12 teacher-provided PDFs imported through
the production origin as `SAMPLE-IMPORT:` drafts) and James's per-import review notes.
Slices A–C the same day fixed the crash-class failures (structured errors, 16k output cap,
keyless items, sharing); everything below is what the review found *after* that.

**What the importer is today, so each item below is measured against it**

- Text-layer extraction only (`lib/pdfImport/extractText.ts`, unpdf). Images, graphs,
  and tables-as-images are dropped before the model sees anything; only scanned PDFs
  (no text layer) go to Bedrock as page images.
- The extractor prompt (`lib/pdfImport/extractCore.ts`) offers four shapes:
  `multiple_choice_single`, `multiple_choice_multi`, `short_text`, `essay`. The app has
  eight item types; `match`, `order`, `hotspot`, `drawing_upload` are never proposed.
- Stems are plain text plus KaTeX math and `![alt](asset:uuid)` image refs. No bold,
  underline, or other rich text survives extraction or renders.
- No passage / stimulus / item-set concept in the schema: every item stands alone.
- Answer keys are optional since slice B; keyless items import and are badged.

Legend — size is a rough shape (S = one slice, M = two to three, L = design first), not
a time estimate.

## Checklist

### Structure and item types

- [x] **E1 — Matching items (Unit 1, items 1–6).** Lettered statements matched 1:1 to a
      left-hand stimulus were imported as multiple-choice, which hides the 1:1 constraint.
      *Today:* the prompt cannot emit `match`. *Direction:* add the `match` shape
      (`pairs: [{left,right}]`) to the extractor prompt and validator; teach it the
      "column A / column B" and "lettered statement bank" layouts. Size S.
      **DONE 2026-09-01 (slice 2):** `match` shape + layout rule in the prompt;
      `normalizePdfCandidate` assigns `p1..pn` pair ids (the model is not asked to
      invent them). Bedrock re-run of Unit 1: rows 1–5 → ONE match item with 5 pairs
      claiming `source_numbers` 1–5, plus 10 MC, 0 rejected (was 13 MC, 2 rejected).
      The panel shows the pair count.
- [x] **E2 — Draw / graph prompts → drawing item (Unit 0, item 7).** A one-line
      "make a graph" style prompt was imported as an essay. *Today:*
      `drawing_upload` exists but is never proposed. *Direction:* prompt
      rule — sketch / draw / graph / plot verbs map to `drawing_upload`; the
      teacher can still flip the type. Size S.
      **DONE 2026-09-01 (slice 2):** verb rule in the prompt; Unit 0 item 7's
      graph-drawing prompt → `drawing_upload` on the Bedrock re-run. The panel
      offers "Add as: Drawing / upload (hand-scored) | Essay text box" on every
      drawing AND essay candidate (James: the choice should be easy to reach), applied
      at Add. Student side, for the record: the client has no file picker — the student
      draws on an in-page canvas with the trackpad and the host uploads the PNG
      (verified in a real AAC session 2026-08-29).
- [ ] **E3 — Fillable table response (Unit 0, item 8b → imported 10).** No item type can
      collect a table today. *Direction:* new `table` item type (fixed headers, N rows,
      cell text; optional key per cell) across schema, editor, delivery bundle, client
      rendering, scoring (exact-match per cell or hand-scored). Size L — needs the Swift
      client too.
      **Design page WRITTEN + D-1…D-6 DECIDED 2026-09-02:** `docs/e3-table-item-design.md`
      (fixed header + labelled rows, every cell a blank; one point per keyed cell;
      numeric cells compared as numbers; plain inputs; blank row labels allowed;
      slices 1–3 ship in one deploy with the client rebuild). **Slice 1 BUILT
      2026-09-02** (schema + write boundary + scoring + bundles + preview grid;
      the picker hides the type until slice 2's editor form). **Slice 2 BUILT
      2026-09-02** (editor form + readiness + review-queue grid; a hand-scored
      table is worth its cells). **Slice 3 BUILT 2026-09-02** (client: model,
      response, `tableField`, fixture regenerated; `swift test` 315 pass).
      **Slice 4 BUILT 2026-09-02** (prompt shape + rule, pipe-table backstop,
      mock `TB:`, panel Add-as; Bedrock re-run of Unit 0: item 8 is a `table`
      candidate, transposed and with the formula line as a column — teacher
      edits). **Slice 5 WRITTEN 2026-09-02**: rows 48–53 in
      `docs/design-tool-manual-checks.md` + client rows. E3 is BUILT end to
      end, unpushed; the hand-runs wait on the deploy.
- [x] **E4 — "Show your work" math items (Solubility, item 4).** Imported as short text;
      the wording implies a worked solution. *Direction:* detect "show your work" and
      propose `drawing_upload` (or essay with math input once E7 lands) instead of
      short_text; keep the numeric answer as a second short_text item if the key is
      present. Size S once the shape rule from E2 exists.

### Stimulus, images, formatting
      **DONE 2026-09-01 (slice 2):** prompt rule — the work becomes an **`essay`** (the
      student types the steps; James, same evening, after seeing that the client's
      drawing answer is a trackpad canvas: typed work for math, drawing only for
      graphs and figures); when the document gives the final answer, a second
      `short_text` "Final answer: <question>" carries it, same source number (2.1).
      Solubility re-run after the flip: all 8 "show your work" rows = essay + "Final
      answer —" short_text (keys empty — that PDF has no key); Unit 0's graph item
      stayed `drawing_upload` and its chi-square work became an essay. The
      drawing↔essay choice from E2 is on both types.
- [ ] **E5 — Context paragraphs and graphs above items (Unit 0 throughout; Unit 1 item
      13).** The passage and figure a question depends on are lost, and there is no place
      to put them. *Today:* no stimulus grouping; images are dropped at extraction.
      *Direction, two parts:* (a) extract embedded images per page and attach them as
      assets (`![…](asset:uuid)`) on the item they precede; (b) a passage/stimulus
      concept — either a `stimulus` field on the item or an item-set that several items
      share. James's note: items with images may each need their own page in the student
      view, which is a delivery/layout decision that belongs with (b). Size L — design
      first (schema, editor, bundle, client layout).
      Design doc: `docs/stimulus-design.md` (measured foundation + proposed shape,
      2026-09-01); scan script `docs/scripts/stimulus-scan.py`.
      **Progress 2026-09-01 night:** decisions made, spikes S1/S3 passed (unpdf only),
      slice 1 (schema/API/editor/bundles/preview) and slice 2 (client renders sets)
      BUILT; slice 4 — (a) above — BUILT: figures extracted with positions and shown
      in the import panel, `[FIGURE n]` markers in the text the model reads. Slice 3
      BUILT: the model returns `item_sets` (stimulus text, figure numbers, item
      indexes), validated and remapped like candidates, a position rule pairs the
      figures it left alone, and the panel shows set cards (split / include / merge /
      discard / edit) whose Add uploads the figures, posts the questions and groups
      them. Remaining under E5: hand-runs, then E3 / E7(b) / E12 as designed.
- [x] **E6 — Rich text in stems (Unit 1 item 7: ABIOTIC bold + underlined; similar
      elsewhere).** Emphasis carries meaning ("which is NOT…"). *Today:* stems have no
      rich-text support. *Direction:* a minimal inline markup allowlist (bold, italic,
      underline) in stems and choices, rendered in the editor, preview, and client, with
      the extractor asked to preserve it when the PDF text layer exposes font runs
      (unpdf can report style per run; verify before promising). Size M.
      **Decision 2026-09-02 (James):** markup is `**bold**` and `_italic_` in
      stems, choices, pairs and stimulus text, rendered beside KaTeX in the
      editor preview and the client; bold and italic only (spike S3: underline
      is a drawn path, not a text property). Build now, before the next
      client rebuild.
      **DONE 2026-09-02.** Markup `**bold**` / `_italic_`, parsed only outside
      `$…$` and image refs; an italic run opens at a word boundary and closes
      before one (`snake_case`, `H_2O` outside math and a blank `______` stay
      literal), runs are never empty, never start or end with whitespace and
      never cross a newline; bold first, italic inside it; no escape syntax
      yet. Three places, one rule: `renderEmphasis` in
      `lib/items/renderItemContent.ts` (editor preview, print, scoring and
      review surfaces — all go through it); the client's page script
      (`AssessmentPage.swift`, DOM-only `strong` / `em` elements with
      text-node children, math segments left for `renderMathInElement`;
      stems, choices, match lefts and stimulus; a select option can only hold
      text so match rights are stripped to the words); and the extractor
      (`extractFigures.ts`): each text run's font is read from
      `page.commonObjs` after the operator list (spike S3), maximal same-style
      runs on a line are wrapped once, and a style covering more than half of
      a page's characters is that page's body face and is not marked (an
      all-bold worksheet stays unmarked). The system prompt tells the model to
      keep the markers where they are and never add or put them inside `$…$`.
      Evidence: design-tool tests 156 pass on the six touched files
      (`makeStyledTextPdf` in `test/helpers/pdf.ts` builds Helvetica /
      Helvetica-Bold / Helvetica-Oblique runs and `extractPdfLayout` marks
      them from a real text layer); `swift test` 297/297; one Bedrock re-run
      of Unit 1 (`samples/_run-import.ts`, Sonnet 4.6, 12 s, 11 candidates, 0
      rejected) kept five bold runs in stems — `**ABIOTIC**`,
      `**independent variable**`, `**dependent variable**`, `**controlled …**`
      and one more. Hand-runs: design-tool row 38 ✅ 2026-09-02 on the origin (stems, choices,
      stimulus in card / iframe / print; match pairs were raw there — fixed in
      e0e74bc with order steps, and the card preview now triggers on emphasis,
      10372c7); client "E6 — bold and italic" rows wait on James at the
      keyboard with the rebuilt app. **Editor Bold / Italic buttons DONE 2026-09-02**
      (`EmphasisButtons.tsx` beside Image… / Math… under stems, choices and
      stimuli: wrap the field's current selection, insert a placeholder at
      the caret, or append one when nothing is focused; an italic run is
      padded so it renders; row 44).
- [x] **E7 — Sub/superscript in formulas (Solubility).** `H2O` imported as flat text,
      making some items wrong. *Direction, two halves:* (a) extractor emits KaTeX for
      chemical/math notation (`$\mathrm{H_2O}$`), which the stem renderer already
      supports; (b) students need sub/superscript when *answering* — a formula-aware
      short-text input in the client with KaTeX preview. (a) is S; (b) is M and touches
      the Swift client.
      **(a) DONE 2026-09-01 (slice 2):** prompt rule — KaTeX inside `$…$` in stems,
      choices and pairs, and `correct_answer` stays PLAIN TEXT on purpose: the
      short-text scorer is a normalized exact match against what the student types,
      so a KaTeX key would never match until (b) exists. Solubility re-run:
      `$\mathrm{K_2Cr_2O_7}$`, `$\mathrm{Pb(NO_3)_2}$` etc. in every stem. (b) open.
      **(b) DONE 2026-09-02.** Client: the short-text field is wrapped with a
      live preview — text carrying `_`, `^`, `$` or `\` renders as
      `\mathrm{…}` through KaTeX under the field (TeX specials `% # & ~`
      escaped, `$` stripped), empty otherwise; a one-line hint ("Subscript
      with _ and superscript with ^ (H_2O, x^2)…") appears only under
      questions whose stem carries `$`. The response stays the raw typed
      text. Scorer (`lib/scoring/auto.ts`): `normalizeShortText` folds
      formula markup on either side only when the text carries it — `$`
      delimiters and `\mathrm{…}` / `\text{…}` unwrap, braces, TeX spacing
      and all whitespace go, and `_` goes because a subscript reads the same
      inline (`H_2O` ≡ `H2O`); `^` stays because an exponent changes the
      value (`10^4` ≠ `104`). The plain policy is untouched ("cell wall" ≠
      "cellwall" still). **Decided 2026-09-02 (James): "plain or folded"** —
      `shortTextMatches` tries the plain comparison first and folds both
      sides only when that fails and either side carries formula markup, so
      a stray underscore in a prose answer ("cell _wall_") can only add a
      match, never take one away. Evidence: scorer tests (typed subscript vs plain key, pasted KaTeX vs plain key, braces
      fold + exponent kept, `10^4` ≠ `104`, KaTeX key vs typed answer), Swift
      300/300 with three new JavaScriptCore tests (data-tex on the preview,
      raw text posted, no preview for prose, hint only under a math stem).
      Hand-runs: client "E7(b)" rows after a rebuild.
- [x] **E8 — Items missing entirely (Unit 1, items 14–15; 15 has a table as an
      image).** *Today:* nothing checks extracted count against the document.
      *Direction:* count question numbers in the text layer and warn "PDF numbers items up
      to 15, extracted 13" with the missing numbers, so a teacher knows what to author by
      hand; image-only items are a subset of E5(a). Size S for the warning.

### Multi-form documents
      **DONE 2026-09-01 (slice 2):** `countNumberedItems` walks `N.` / `N)` markers in
      the space-joined text layer (consecutive from 1, one gap tolerated, years and
      decimals ignored, answer-key restarts ignored); each candidate may claim its
      printed number (`source_number`, or `source_numbers` for a match set built from
      several rows — without that, Unit 1's match item made 2–5 look missing); the route
      returns `numbered_items` / `extracted_count` / `missing_numbers` / `shortfall`
      (any shortfall warns — James's 2.2) and the panel shows "numbers up to N; M
      extracted. Not found: …". Scanned PDFs (no text layer) skip it. On the re-runs
      nothing was short (Unit 1's 14–15 now extract), so the warning is exercised by
      the unit + route tests only. Found on the way: the prompt told the model to OMIT
      `correct_choice_ids` for keyless MC while the schema requires the array, so
      Bedrock's keyless MCs were rejected as "correct_choice_ids: Required" (the mock
      always sent `[]`) — `normalizePdfCandidate` now fills `[]`, which is what slice
      B's keyless import always meant (Solubility: 4 rejected → 0).
- [x] **E9 — Multiple forms on one page (Solubility: two forms per page, four total;
      Boyle's/Combined Gas had Form A–D labels).** Duplicate or near-duplicate items get
      imported as a single flat list. (Slice 2's Solubility re-run shows the shape: 32
      raw candidates = 4 forms × 8, each stem prefixed "Form A Q1:" … by the model on
      its own; E8 reports no shortfall because per-form numbering runs 1–6.) *Direction:* detect repeated stems / "Form X"
      markers, group candidates by form, and let the teacher choose "import Form A only",
      "all forms", or "one assessment per form". Size M.
      **Decision 2026-09-02 (James):** a panel toggle (Form A only / all forms /
      one assessment per form). Accepting several forms into one assessment
      is in scope now; assigning different forms to different students in a
      class — the delivery/client side — is DEFERRED to post-MVP. Design
      against row 36's shape, not the earlier one: Solubility now comes back
      as four clean sets of six with no "Form A Q1:" prefixes, so detection
      has to work from repeated stems across sets, not from the prefix.
      **Slice 1 DONE 2026-09-02:** detection is from the numbering, not the
      stems — `detectForms` (`lib/pdfImport/extractCore.ts`) walks the
      validated candidates' printed numbers and starts a new group where the
      next number is below the group's high so far (an E4 twin repeating its
      number stays, a match set counts its whole range, unnumbered items stay
      put); forms are reported only with ≥ 2 groups, every group ≥ 2
      questions and the smallest ≥ half the largest, because sections
      numbered from 1 inside one form look identical. `countFormLabels` is
      the fallback: "Form A / Form B" labels with continuous numbering give a
      count and no groups. The route returns `forms`; the panel shows "This
      PDF looks like N forms (6 / 6 / 6 / 6 questions, each numbered from 1)"
      with **All forms** (default — today's behaviour) or **Form 1 only**,
      which hides the other groups from the list and from Add all. Tests in
      `test/pdf-extract.test.ts` and the route test. Evidence on real output:
      Solubility through Bedrock (2026-09-02, 28 candidates, 0 rejected) →
      `forms.count` 4, groups of 7 / 7 / 7 / 7 — the E4 "Final answer" twins
      repeat their numbers (3,3 / 4,4 / 2,2 / 4,4) and stay in their form,
      and each group is exactly one model set with its own copy of the curve.
      **Slice 2 DONE 2026-09-02:** a third choice, **One assessment per
      form** — Add all puts Form 1 into this draft and, for every other
      group, creates a sibling draft named "<this draft> — Form N" (POST
      `/api/assessments`, then the group's questions and sets posted to that
      id through the same `postItem` / `addSet`, now taking a target id; the
      figures are owner-level assets so they are shared, not re-uploaded) and
      lists the new drafts as links under the notice. The list shows Form 1
      in that mode; per-item Add stays on this draft. Typecheck-verified
      only — the panel has no component tests; hand-run rows 40–41 ✅ 2026-09-02
      on the origin (Form 1 only, All forms, and the split into "Solubility —
      Form 2/3/4" with 8 questions each). Per-student
      form assignment (delivery / client) stays DEFERRED post-MVP.

### Keys and scoring

- [x] **E10 — Import without a key; edit or omit a key later (Self-Driving outline).**
      Done in slice B (8689851): keyless items import, are badged, and the key can be
      filled after publishing.
- [ ] **E11 — Rescoring after a key changes (DECISION DEFERRED).** Today a response that
      already has a final score is never re-scored when a key is filled or corrected; only
      still-unscored responses pick up the new key on the next auto-score run. James wants
      teacher input before making this canonical. Options to put in front of teachers:
      (1) keep as is; (2) re-score automatically and show a change log; (3) re-score on an
      explicit "Re-score with new key" action with a before/after preview. Do not build
      until decided.

### Scanned PDFs (found 2026-09-02)

Both found by James spot-checking a real scan-to-email of the Graphing Skills
pre-assessment (4 pages, no text layer, one full-page CCITTFax image per page)
against the origin — the first time the OCR path had been run on a genuine
scan. Both are specific to the scanned branch: on the text-layer path
`extractPdfLayout` attaches real figures and the model leaves `stimulus` empty,
which is what the prompt asks for. On a scan, `import-pdf/route.ts:180` guards
the whole figure walk behind `if (!scanned)`, so `figures = []`, the input
carries no `[FIGURE n]` markers, and nothing downstream can bind or strip one.
Neither is a regression — the scanned path had never been checked past "did
items come back".

- [x] **E13 — A scanned figure becomes prose, and the prose can give away the
      answer (Graphing Skills scan).** With no figure to attach, the model
      writes a description of the graph into the set's `stimulus_text` instead
      of the `""` the prompt asks for when the figure alone is the stimulus.
      The descriptions are accurate, which is what makes this dangerous: the
      items look well-formed and nothing flags them. On four "Identify the
      type of graph:" items, every stimulus named the graph type the item
      was asking for (a **histogram**, a **line graph**, a **scatter plot**,
      a **bar graph**, each with the description naming its own axis labels
      and title). Four for four, in `graph test` on the origin
      (assessment `a504454e-…`, since deleted). *Today:* no rule distinguishes
      "describe the figure so the question still makes sense" from "the figure
      IS the question". *Direction, a design question rather than a fix:*
      either keep the description and warn the teacher that a scanned figure
      was flattened to text (cheap, honest, leaves the leak for a human to
      catch), or have the model omit descriptions on the scanned path and mark
      the set as needing a figure the teacher supplies by hand (safer, more
      work for the teacher). Whichever way, a scanned figure cannot become an
      asset the way a text-layer one does — that is the underlying constraint.
      Size M and it needs a decision first.
      **DECIDED + DONE 2026-09-02** (James: verbatim-only + `needs_figure`
      badge, over warn-only). `PDF_OCR_USER_PROMPT` now says a stimulus is
      text printed on the page copied verbatim, never a description of a
      graph, chart, diagram or picture, and asks for questions that depend on
      a visible figure as an item_set with `"needs_figure": true`.
      `validateProposedSets` honours the flag only when the set carries no
      figure of its own, keeps such a set even with no text (the empty-set
      drop exempts it) and puts `needs_figure: true` on the ProposedSet.
      Panel: the card header gains "· figure not extracted" plus a one-line
      instruction ("add it by hand in the editor after Add; do not describe
      it here"), a warning above the list counts the flagged sets, and a
      merge keeps the flag. Add posts the set as it is (stimulus text only),
      so a textless one lands in the editor with the existing Empty badge and
      "Stimulus for question N is empty" on the publish checklist — nothing
      new is persisted, no migration. Evidence, one Bedrock re-run of the
      same scan through `samples/_run-import.ts` (Sonnet 4.6, 27 s): 11
      candidates, 0 rejected, 6 sets all `needs_figure`, five with an empty
      stimulus and one (the sleep-per-grade item) carrying the printed
      lead-in sentence, which the stem also carries, so that card shows it
      twice; no stem or stimulus holds a marker or a graph-type word outside
      the four items' own answer choices. One run is a shape, not a
      guarantee. Panel hand-run: row 37 ✅ 2026-09-02 on the origin (2 sets flagged, no
      markers, no description; the empty card lands as an Empty stimulus). The scan itself stays out of the repo
      (`samples/Graphing Skills SCAN 2026-09-02.pdf`, gitignored; the
      original is `~/Downloads/Scan to Email_20260902_092034.pdf`).
- [x] **E14 — `[FIGURE n]` markers leak into student-visible stems (same
      scan).** Six of the eleven stems came back ending in a literal
      `[FIGURE 1]` … `[FIGURE 6]`, pointing at figures that were never
      extracted — e.g. `Identify the type of graph: [FIGURE 1]`. The system
      prompt already forbids exactly this (`lib/pdfImport/extractCore.ts:81`,
      "Never put the [FIGURE n] marker text itself into a stem or stimulus"),
      but that prompt is shared by both paths, and on a scan the model invents
      markers for figures it can see even though the input contains none.
      Nothing strips them server-side, so they would reach a student verbatim.
      *Direction:* strip `\[FIGURE \d+\]` from stems and stimuli in
      `normalizePdfCandidate` whenever `figure_count === 0` — the marker cannot
      refer to anything real in that case. Belt-and-braces: say in the OCR user
      prompt that the attached pages carry no markers. Size S, and independent
      of E13's decision.
      **DONE 2026-09-02:** `stripFigureMarkers` in `lib/pdfImport/extractCore.ts`
      removes `\s*[FIGURE n]` from a stem (`normalizePdfCandidate`, new
      `{ figureCount }` option, the route passes `figures.length`) and from a
      set's stimulus (`validateProposedSets`, which already had the count),
      only when the count is 0 — on the text path nothing is touched. A stem
      that was only a marker fails `min(1)` and is reported, not proposed.
      `PDF_OCR_USER_PROMPT` now says the document contains no markers. In the
      same slice the row-31 "card offering nothing" is gone: a set left with
      no existing figure and no text is rejected as `empty` and its questions
      stay plain candidates (on a scan every figure number is out of range, so
      a figure-only set is exactly that). The mock's scanned fixture now
      carries both shapes (`[FIGURE 1]` on the second stem, a figure-only set)
      so the route test proves the strip and the drop end to end; unit tests
      in `test/pdf-extract.test.ts`. Not re-run against Bedrock — the prompt
      line is belt-and-braces and the strip is deterministic.

### New concepts

- [ ] **E12 — A student's response seeding a later assessment (Self-Driving outline →
      essay).** The outline a student writes in one assessment becomes the stimulus for
      their essay in another. *Today:* no link between assessments, and stimulus (E5) does
      not exist. *Direction:* design question before any slice — per-student stimulus
      pulled from a prior attempt (needs E5's stimulus concept, a "source item" link, and a
      delivery rule for which attempt to use). Size L — write a one-page design first.
      **Design page WRITTEN 2026-09-02:** `docs/e12-per-student-stimulus-design.md`
      — two nullable columns on `item_sets` (`source_item_id`,
      `source_fallback_text`), resolution inside the per-student delivery
      route (no stored per-student text), same-owner sources in v1, four
      slices, six decisions D-1…D-6 for James. Nothing built.

## Suggested order

E1, E2, E4, E8 and E7(a) LANDED 2026-09-01 as slice 2 (prompt + `normalizePdfCandidate`
+ numbering report in `lib/pdfImport/extractCore.ts`, mock `MA:`/`DR:`/`#n` segments,
route fields, panel; tests in `test/pdf-extract.test.ts` + `test/pdf-import-route.test.ts`;
Bedrock re-runs of Unit 0, Unit 1 and Solubility as the evidence, JSON + gallery in
`samples/import-run/`, gitignored). E5's decisions were made the same evening
(`docs/stimulus-design.md`): next is spike S1, then the schema slices. E6 and E9 are
medium. E5 is the big one and unlocks E3, E7(b) client work,
and E12; do its design doc before touching schema. E11 waits for teachers. E13/E14 came out of the first real scanned-PDF run (2026-09-02); E14 is a small independent fix, E13 needs a decision before any slice. E14 LANDED
2026-09-02 (with the row-31 empty-set drop); E13 DECIDED + LANDED the same day.
E6, E7(b) and E9 (slices 1–2) LANDED the same day and were DEPLOYED 2026-09-02;
hand-runs 37–42 ✅ on the origin. E3 BUILT end to end 2026-09-02 (slices 1–5,
`docs/e3-table-item-design.md`; rows 48–53 + client rows wait on the deploy).
Left: E11 (teachers), E12 hand-runs (slices 1–4 BUILT 2026-09-02). Both small proposals from the hand-run are DONE 2026-09-02: editor Bold / Italic
buttons, and an imported copy now named "(copy)" for its owner. The editor's question list not refreshing after
Add from a panel was a real defect (state initialised once from props, nothing
synced on router.refresh) — fixed 2026-09-02, row 43 of the checks doc.
