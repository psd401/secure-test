# Authoring editor redesign (proposed roadmap row ER; not yet in `docs/roadmap-2026-09.md`)

Design note, 2026-10-25. Trigger: early teacher feedback, given in
conversation rather than through the feedback form, that the design tool
is daunting to get started in. Direction (James): a WYSIWYG editor that
never shows formatting markers, drag-and-drop as a first-class way to
work, and side-by-side views for (1) editor | student preview and
(2) uploaded source | preview. Decisions marked **D-n** are James's
answers of 2026-10-25; **R-n** are recommendations to confirm.
**§Progress says what is built** (nothing yet). Branch:
`design/editor-redesign`.

A four-screen mockup (start screen, editor + preview, import review,
add-question menu + math entry) is a private design canvas; ask the
maintainer for the link.

## What exists that this replaces or stands on

- **Text entry is raw markup.** Every stem, choice and stimulus is a
  `<textarea>` holding the ADR 0009 / 0010 markup: `$…$` / `$$…$$` KaTeX
  (a `$` before a digit is money, `\$` literal), `**bold**` / `_italic_`
  (word-boundary rules, no escape), `![alt](asset:<uuid>)`, and `[[id]]`
  blanks. B / I buttons wrap the selection in markers
  (`EmphasisButtons.tsx`); a dashed preview strip renders below the field
  (`MathPreview.tsx` → `app/actions/renderContent.ts`). Beta batch A
  (`docs/roadmap-2026-09.md`) recorded a teacher reading raw LaTeX on a
  proposal card as a broken import.
- **One 3,703-line client component** (`app/dashboard/[id]/AssessmentEditor.tsx`)
  holds the Questions tab, settings, per-type editors and a per-question
  **Save question** button. New questions start with real text ("New
  question", "Choice A"). UX pass 3 (`docs/ux-pass-3-research.md`) findings
  UX3-1 (defaults are content), UX3-3 (Save button is the largest gap to
  Forms) and UX3-4 (Add sits above a list that grows down) are unbuilt.
- **Preview** is a sandboxed, script-free iframe (`components/app/PreviewFrame.tsx`
  → `/preview/[id]`, ADR 0006 CSP) stacked above the list, refreshed only
  after a save.
- **Two renderer implementations** that must agree: the server's
  TypeScript (`lib/items/renderItemContent.ts`, used by
  `lib/preview/renderHtml.ts` and the inline previews) and the client's
  JavaScript held in Swift string literals (`AssessmentPage.swift`,
  `AssessmentPageRichText.swift`). Since v2.0 the client runs the
  **server-delivered signed renderer** (ADR 0018), still built in
  *bridge mode* (D-9 of `docs/server-delivered-renderer-design.md`):
  `packages/renderer` extracts `renderer.js` / `renderer.css` from the
  Swift literals. "Slice 5" of that design moves ownership into the
  package and deletes the literals. No test found compares the two
  implementations' output on the same markup.
- **Import.** PDF item import (`PdfImportPanel.tsx`,
  `/api/assessments/[id]/items/import-pdf`) proposes cards and never
  saves, but never shows the source PDF. CSV import covers four types.
  JSON (`ItemBundle`) import creates a new assessment with no review.
  `.docx` is already accepted as a Converse document block for rubric
  upload and batch generation (`lib/ai/documentUpload.ts`), but not by
  item import.
- **Drive.** Incremental `drive.file` authorization is built for
  release-to-Google-Docs (`docs/google-docs-release-design.md`,
  `lib/googleDocs/driveAuth.ts`, `/api/google/drive/start` + `/callback`):
  no stored token, one-hour token in an httpOnly cookie, Workspace-internal
  OAuth client.
- **Drag-and-drop**: none in authoring except drawing hotspot rectangles.
  Question order uses up/down buttons and the reorder route, which refuses
  to split an item set.
- **Styling**: Tailwind v4 + shadcn/ui (Radix), PSD palette mapped to
  shadcn tokens in `app/globals.css`, Inter + Josefin Sans, light only.
  No rich-text editor dependency.

## Decisions (James, 2026-10-25)

- **D-1 Option B: consolidate the renderer.** Move the renderer source
  out of Swift into `packages/renderer` (renderer design slice 5) and run
  that same signed renderer in the editor's preview. Chosen over keeping
  two implementations (A) because of D-2 and D-3.
- **D-2 The preview is interactive.** A teacher can answer an item in the
  preview and see how it would be scored. This needs a scripted preview
  (R-3).
- **D-3 New formatting**: lists, underline and alignment in authored
  text, beyond bold, italic, math, images and blanks.
- **D-4 Forcing v2 updates is acceptable.** New markup may raise the
  minimum client/renderer version; an older client is told to update
  rather than shown content it cannot render.
- **D-5 The start screen offers templates and an AI draft** alongside
  blank, import and open-a-file.
- **D-6 JSON import stays "create a new assessment"**, but gains a
  preview before it commits (R-9).
- **D-7 Google Doc import** joins PDF and Word.
- **D-8 No record of the original feedback is kept in `docs/`**; it came
  from impromptu conversations.
- **D-9 Trunk-based delivery behind a flag, not one long branch.** Each
  slice is a short-lived branch and PR merged to `main` and deployed
  normally. The new editor and start screen sit behind a flag (R-12)
  whose default is the current editor, so teachers see nothing until
  the cutover. Why not build everything on `design/editor-redesign` and
  merge at the end: `AssessmentEditor.tsx` changes often on `main`, so
  the final merge would be large and risky; one large PR gets a weaker
  CI / security / AI review than many small ones; slice 5's page-work
  freeze cannot stay open for the whole project, and the renderer is
  signed and deployed from `main`; Phase 1 is useful on its own; and the
  hotfix route assumes `main` stays close to the live commit.

## Recommendations (for James to confirm)

- **R-1 The stored format stays a markup string.** The editor serializes
  to the same `stem: string` the bundles carry, extended (D-3) rather
  than replaced. No HTML or editor JSON is stored. This keeps both wire
  formats (ADR 0016), export/import round-trip, the AI and import
  pipelines, and the readiness checks unchanged in shape.
- **R-2 One shared markup package.** `packages/markup` (name open) owns
  the grammar: `parse(markup) → AST` and `serialize(AST) → markup`, with
  a property test that `serialize(parse(s)) === s` for every fixture and
  for canonical forms. The editor, the server renderer and (after slice
  5) the client renderer all consume it. Golden fixtures (markup in,
  expected DOM out) run against both renderers until slice 5 retires the
  second; client-side they run in the existing JSC harness, since
  headless Chrome hangs on this Mac (ADR 0013).
- **R-3 A new ADR revises ADR 0006 for a scripted preview.** Proposed
  posture: `sandbox="allow-scripts"` **without** `allow-same-origin`
  (opaque origin, no cookies, no API access), a CSP allowing only the
  renderer script by hash, no network, and the item content posted in by
  `postMessage` from the parent. The preview runs the same `renderer.js`
  a student gets; a stub bridge answers `response` / `submit` locally and
  scores against the key the editor already holds, so no answer key
  enters the delivery path.
- **R-4 Editor library: prototype Tiptap core (MIT, ProseMirror) first.**
  Our content is inline formatting saved as one string, which a small
  ProseMirror schema fits better than a block editor. BlockNote is the
  fallback. Math reuses KaTeX and the existing `MathTranslator`
  (plain-words → LaTeX) plus MathLive from `packages/graphing`; no paid
  Tiptap extensions. The prototype passes when every fixture round-trips
  unchanged and paste from Word / Google Docs keeps only supported marks.
- **R-5 Autosave replaces Save question.** Debounced writes through the
  existing `UpdateItemBody` path, an "All changes saved" indicator, and
  version history at item granularity. Keyless and incomplete items
  stay legal drafts; the readiness check becomes a "Before publishing"
  list, each entry linking to the item.
- **R-6 Insertion and type change in place.** A "+" between items and a
  `/` menu; the menu leads with the six common types, the rest under
  "More types". Changing type keeps stem and options and warns before a
  key would be lost.
- **R-7 Every drag has a click path.** Outline reorder, choice reorder,
  match and order keys: drag, or select-then-click / Move up / Move down
  (WCAG 2.2 SC 2.5.7), with live-region announcements. Reorder still
  refuses to split an item set.
- **R-8 Import review is side by side and triaged.** Source on the left
  (the PDF page, or Word/Doc rendered), numbered regions linked both ways
  to the proposed items on the right. Each item is *ready*, *needs a
  key*, *check this* (low-confidence field highlighted in the card) or
  *can't convert* (choose a type or leave it out); nothing is silently
  downgraded. Items are accepted one by one or "accept all ready". Still
  propose-only: nothing is written until the teacher adds.
- **R-9 JSON import gets a preview step**: the bundle rendered as students
  will see it, with counts, before the new assessment is created.
- **R-10 Word, then Google Doc.**
  - Word: route `.docx` through item import using the existing document
    block path. A teacher-facing tip on the drop zone covers Google Docs
    on day one ("File → Download → Microsoft Word").
  - Google Doc: a "Choose from Google Drive" button opens the Google
    Picker; under `drive.file` the picked file becomes readable by the
    app; the server exports it as `.docx` (Drive `files.export`) and
    feeds the Word path. Reuses the built incremental-authorization
    routes; token handling unchanged (no storage). New: the Picker needs
    a browser API key and the project number (CDK context, never source),
    and the CSP must allow Google's Picker script and frame on that page
    only.
- **R-11 Layout at laptop widths.** Side-by-side at ≥ 1280 px; below
  that, a tab toggle between the two panes. Scroll linking is by
  anchored item, not by percentage, and can be turned off.
- **R-12 One flag for the new authoring experience (D-9).** Widens R-4's
  prototype flag to cover the new editor, the side-by-side preview, the
  import redesign, the start screen and the new formatting controls.
  Default off; James and pilot teachers opt in. While both editors exist,
  tests and `docs/design-tool-manual-checks.md` rows cover both, and
  `public/help.html` keeps describing the current editor (pilot teachers
  get a short separate note). Work that cannot be flagged:
  - **Slice 5** reaches every student. It must change no rendered
    output; Phase 1's fixtures are the evidence.
  - **New formatting** is authored only from the flagged editor, so no
    item can carry a list or underline before the floor raise; the
    floor date is announced ahead (D-4).

## Phases

Each phase is its own PR or PR series, merged to `main` and deployed as
it lands (D-9); one commit per slice. User-visible work stays behind the
R-12 flag until Phase 9.

1. **Markup package + fixtures** (R-2). Extract the grammar from
   `renderItemContent.ts`; golden fixtures for every construct including
   the money rule and the no-escape `**` case; run them against the
   server renderer and the client renderer (JSC). No user-visible change.
2. **Renderer slice 5 + preview ADR** (D-1, R-3). Needs a page-work
   freeze on `AssessmentPage.swift`: other worktrees that touch the page
   land or wait first. The renderer source moves to TypeScript in
   `packages/renderer`; the extractor and Swift literals are retired; one
   signed deploy (Touch ID) ships it. The ADR is written and accepted
   before the scripted preview is built.
3. **Editor prototype** (R-4). Tiptap behind a per-assessment flag on the
   Questions tab for MC and short answer only; round-trip and paste tests.
4. **Editor build-out** (R-5, R-6, R-7). Autosave, outline rail with
   drag, "+" and `/` menus, in-place type change, remaining item types,
   then split `AssessmentEditor.tsx` along the new seams.
5. **Interactive side-by-side preview** (D-2, R-3, R-11), with
   accommodation views (text-to-speech, paged layout) and click-to-jump.
6. **New formatting** (D-3, D-4). Lists, underline, alignment in the
   grammar, both renderers' fixtures, the editor and the item-type gate
   (`MIN_CLIENT_VERSION_FOR_TYPE`-style floor in `lib/items/clientSupport.ts`).
7. **Import redesign** (R-8, R-9, R-10). PDF side by side with triage,
   then Word, then the Drive picker.
8. **Start screen** (D-5). Blank-with-example, import, open-a-file,
   templates, AI draft (gated by `allow_llm_authoring` like today).

9. **Cutover and cleanup** (D-9, R-12). Flip the flag's default once the
   pilot hand-runs pass; update `public/help.html` and the manual checks
   to the new editor; after a settling period, a final slice deletes the
   old editor code and the flag.

Phases 3–4 and 7 can run in parallel once 1 is done; 5 needs 2 and 3;
6 needs 2; 9 needs all the others.

## The external asks

- **Google Cloud console (James):** enable the Google Picker API on the
  existing OAuth project and create a browser API key restricted to the
  app's origin and the Picker API. `drive.file` is already on the consent
  screen for release-to-Docs.
- **Workspace admin (IT):** likely **none**: the OAuth client is
  Workspace-internal and `drive.file` is already granted for
  release-to-Docs. Confirm before Phase 7 that the admin console's API
  controls do not block the Picker for teachers; if they do, it joins the
  next batched IT request (details in the ops repository).
- **Fleet:** D-4 means a renderer floor raise in Phase 6; IT's AutoPkg
  recipe delivers releases next day, so announce the floor date ahead.

## Risks

- **Round-trip loss.** An editor that cannot represent a construct would
  silently rewrite stored items. Mitigation: R-2's property test gates
  every editor change; an unrepresentable construct opens read-only with
  a "show source" fallback rather than being rewritten.
- **Slice 5 freeze.** Four worktrees were open on 2026-10-25; the freeze
  has to be scheduled, and a renderer change cannot ship as a hotfix.
- **Scripted preview security.** Mitigated by R-3's opaque origin, hash-
  pinned script and no network; the ADR records the residual risk.
- **Testing limits.** The editor and preview are browser UI this Mac
  cannot drive headlessly; each phase adds rows to
  `docs/design-tool-manual-checks.md` and James hand-runs them.
- **Help pages.** `public/help.html` follows button labels; every phase
  that renames or moves a control updates it in the same PR.

## Research basis (2026-10-25)

Summarised from four research passes; sources are official help/docs
unless noted.

- **Ed-tech authoring**: Formative's side-by-side PDF "Enhance" view and
  page picker; Microsoft Forms' import triage (missing / uncertain /
  unsupported, mark Resolved); Kahoot's opt-in per-question Add for AI
  items; Pear Assessment's import summary; Google Forms' separate
  answer-key mode as a known stumble; Canvas New Quizzes' preview that
  does not render equations in feedback.
- **Outside ed-tech**: Rossum's two-way linking between source boxes and
  fields with yellow / green / red status and a confirm gate; Docsumo and
  AWS A2I confidence thresholds; Tally's type-to-start form and `/` menu;
  Notion's drag handle with "Turn into" and automatic version history;
  Overleaf's visual editor that reveals source only at the cursor and
  links PDF to source; Beehiiv and Mailchimp clean-paste for a
  constrained output format; Storybook toolbar preview modes; TurboTax's
  review step that links each error to its screen; Canva template locks.
- **Standards**: NN/g on direct manipulation; WCAG 2.2 SC 2.5.7 (single-
  pointer alternative to dragging); ATAG 2.0 Part B (prompt for alt text
  at insertion, which today defaults to the file name in
  `ImagePicker.tsx`).
- **Anti-patterns to avoid**: silent type downgrades on import, AI output
  that replaces existing work, type changes that drop data without
  warning, previews that approximate the real renderer, review flags that
  do not link to a fix.

## Questions

1. Markup package name and home: `packages/markup` or inside
   `packages/schema`?
2. Version history: item-level snapshots in Postgres, or reuse an
   existing audit table?
3. Templates (D-5): district-curated, teacher-shared, or both?
4. Underline (D-3): students read underline as a link; restrict it to
   stimulus text, or allow everywhere?

## Progress

- 2026-10-25 — note written; D-1…D-8 decided; mockup drawn; nothing built.
- 2026-10-25 — D-9 (trunk-based delivery behind a flag) decided; R-12 and
  Phase 9 (cutover and cleanup) added.
- 2026-10-25 — **Phase 1 built** (prototype track, branch
  `prototype/editor-redesign`; Q1 answered `packages/markup`).
  `packages/markup`: `parse` / `serialize` / `renderedForm`, exported as
  TypeScript source like `packages/graphing`; `serialize(parse(s)) === s`
  for every fixture, every construct's canonical spelling and 5,000 random
  strings. 55 golden fixtures (`packages/markup/test/fixtures/golden.json`,
  money rule and the no-escape `**` case included) pass against the server
  renderer byte for byte and against the client's bridge-mode `renderer.js`
  in the client harness's DOM shim (`design-tool/test/markup-golden.test.ts`,
  run from bun, whose engine is JavaScriptCore), and a differential pass
  over random markup holds both renderers to the parser. No rendered output
  changed; `renderItemContent.ts` does not consume the package yet.
  **Findings** — the two renderers agree on every plain stem tried (tens of
  thousands of random stems), and disagree only when a fill-in-the-blank
  marker sits inside a formula or a picture's alt text (each pinned in the
  test):
  - **ER-F1** marker inside alt text (`![a [[b1]] b](asset:…)`): the server
    falls back to segment-by-segment rendering, so the picture is literal
    text with the blank inline; the client makes the picture (its alt
    carrying the private-use sentinel) and moves the blank after the
    sentence.
  - **ER-F2** marker inside a formula (`$[[b1]] **a**$ **b**`): the server
    re-reads each segment on its own (here `**a**` turns bold); the client
    keeps the whole stem's math/emphasis reading and only splits the text at
    the blank (here `**a**` stays literal).
  - **ER-F3** marker after a backslash in a formula (`$\[[b1]]$`): KaTeX
    renders `\` + sentinel as a red error with the sentinel once, so the
    server's fallback check passes and the blank lands inside KaTeX's markup.
  - Not grammar, and expected: a missing picture's class is `image-missing`
    on the server and `missing-asset` on the client; the server's `<img>`
    points at the asset route, the client's is a data URI made enlargeable.
  The parser follows the server's general rule (ER-F1, ER-F2). The editor
  should treat a marker inside math or alt text as unrepresentable (Risks:
  open read-only) rather than reproduce either renderer.
- 2026-10-26 — **Phase 3 slice A: the R-12 flag** (prototype track). One
  per-staff row in a new `staff_preferences` table (`new_authoring`, default
  false; migration 0064, additive), read only through
  `isNewAuthoringEnabled(db, session)` in `design-tool/lib/authoring/flag.ts`
  so Phase 9's cutover is one constant (`NEW_AUTHORING_DEFAULT`). Opt-in and
  opt-out at `/dashboard/beta` (linked from nowhere while the default is off)
  through `GET` / `POST /api/me/preferences`; an act-as session reads the
  teacher's choice but cannot change it (403). Tiptap and dnd-kit added as
  design-tool dependencies for the slices that follow; nothing imports them
  yet. With the flag off nothing a teacher sees has changed.
- 2026-10-26 — **Phase 3 slice B: the WYSIWYG field** (prototype track, R-4).
  `app/dashboard/[id]/RichTextField.tsx` (Tiptap MIT core, no StarterKit or
  paid extensions) replaces the stem textarea of multiple choice (single and
  multi-select) and short answer, and each choice's input, when the R-12 flag
  is on; every other type and the flag-off editor are unchanged. Schema
  (`lib/authoring/markupExtensions.ts`): one paragraph of text with `strong` /
  `em` marks, `hardBreak` (newline), and atoms `escapedDollar` (`\$`),
  `blank`, `math` (KaTeX node view; click to edit its TeX; insert through the
  existing Math… translator) and `image` (assessment-scoped asset URL; insert
  through the existing Image… picker). MathLive is not wired in. No input
  rules: typed `**` or `$` stay characters. `lib/authoring/markupDoc.ts` maps
  markup ↔ document; saving tries the plain string, then one with typed `$`
  escaped, and flags anything else (typed `**`, mid-word italic) with a
  student preview rather than hiding it. **Round-trip gate**
  (`test/authoring-editor.test.ts`): all 55 golden fixtures load into the
  schema (`getSchema(...).nodeFromJSON`) and save back byte for byte; 3,000
  random strings, read with and without blanks, each either round-trip or
  are refused. Refused, so opened
  read-only with **Show source**: two bolds with nothing between
  (`**a****b**`, ProseMirror merges them) and a blank marker inside math or
  alt text (ER-F1–F3). **Clean paste** (`lib/authoring/pasteSanitize.ts`,
  `test/authoring-paste.test.ts`): Word and Google Docs HTML (hand-built
  fixtures) keep text, bold, italic and line breaks only; the Docs
  `font-weight:normal` wrapper is not bold; pictures are dropped and counted.
  Browser behaviour is hand-check rows 695–712.
- 2026-10-26 — **Phase 3 review fix.** The new field's type list named
  `multiple_choice`, which is not an item type, so single-answer multiple
  choice (the default type) kept the textarea with the flag on. The list now
  lives in `lib/authoring/richTextTypes.ts`, typed as `ItemType` so a
  misspelt name fails typecheck, and `test/authoring-editor.test.ts` pins its
  membership against `ITEM_TYPES`. Hand-check row 713.
- 2026-10-26 — **Phase 4 slice A: autosave and version history** (prototype
  track, R-5; Q2 answered: a new table). With the R-12 flag on, each question
  card saves itself a second after its last edit through the existing item
  PATCH (`itemPatchBody` in `AssessmentEditor.tsx`, now shared by Save
  question, autosave and restore); one per-card debounce on the existing
  `createAutosave` (`lib/authoring/itemAutosave.ts`), so cards never wait on
  each other, a failed save is not retried in a loop, and an edit undone
  before the timer fires is never written. One indicator above the list (All
  changes saved / Saving… / "Some changes didn't save" with links and Try
  again); no Save question button. **History**: the item PATCH now copies the
  content it replaces into `item_snapshots` (migration 0065, additive) —
  coalesced to one copy per item every two minutes, newest 50 kept, deleted
  with the item, teacher plane only (ADR 0016) — for every editor, so history
  exists when the flag's default flips; `GET …/items/[itemId]/history`
  (`edit` access) lists them, and a restore is an ordinary PATCH with
  `?restore=1`, which always keeps the version it replaces. **Before
  publishing**: the readiness checks as a list of links (`beforePublishing`
  in `readiness.ts`, no five-entry cut-off) that scroll to the question and
  focus its text; gaps never block a draft. Tests:
  `test/item-autosave.test.ts` (debounce, indicator, capture rule, list) and
  `test/item-history-api.test.ts` (capture, coalescing, cap, cascade, restore
  round-trip for three types, publish lock, route access). Browser behaviour
  is hand-check rows 714–726. Not built: autosave for stimulus sets and
  assessment settings (they keep their own Save buttons).
- 2026-10-26 — **Phase 4 slice B: outline, insertion, type change** (prototype
  track, R-6, R-7). With the R-12 flag on: an **outline rail** beside the
  question list (`OutlineRail.tsx`), one row per block — a lone question or a
  stimulus set, which move whole so no order can split a set — reordered by
  drag (@dnd-kit, pointer and keyboard) or by selecting a row and Move up /
  Move down (WCAG 2.2 SC 2.5.7), both announced in a live region and saved
  through the existing reorder route (refusals put the order back). A **"+"**
  before every block and **Add question** at the end open the add menu
  (`InsertQuestionMenu.tsx`): six types first, the rest under More types,
  type-to-filter; "/" on a card outside a text field opens it after that
  block. The new question is created through the existing items POST and
  moved into place with the reorder route (UX3-4), and starts **empty** with
  placeholders (UX3-1) — the item routes accept an empty stem only for
  flagged staff (`parseItemBody` in `lib/api/items.ts`); matching, ordering,
  table and fill-in-the-blank keep their starter text because the write
  boundary requires it. **In-place type change** (`TypeChangeControl.tsx`,
  `lib/authoring/typeChange.ts`): stem always kept; choices kept between the
  two multiple-choice types and mapped to / from ordering steps; a warning
  names what goes (an answer key first) before the change; matching, table
  and fill-in-the-blank are not offered as targets. The item PATCH accepts a
  type change only for flagged staff, only in draft and not once students have
  answered (`type_change_has_responses`, 409); the config starts afresh, and
  the editor saves it with `?restore=1` so History can restore across types.
  **Choice reorder** (multiple choice in the new field): drag handle plus
  Move up / Move down, letters by position as the preview shows them. Pure
  logic in `lib/authoring/outline.ts` and `insertTypes.ts`; tests
  `test/authoring-outline.test.ts`, `test/authoring-type-change.test.ts`,
  `test/item-insert-type-change-api.test.ts`. Browser behaviour is hand-check
  rows 727–746. Not built: within-set reordering from the rail, match / order
  key reordering by drag (they keep their own controls), and splitting
  `AssessmentEditor.tsx`.
- 2026-10-26 — **Phase 4 slice C: every item type in the new editor**
  (prototype track, R-7). With the R-12 flag on, every item type's question
  text is the new field (`RICH_TEXT_TYPES` is now all of `ITEM_TYPES`); each
  type's own panel (rubric, pairs, steps, hotspots, reference image, table,
  blanks, graph) is the existing sub-editor, reused unchanged. **Fill in the
  blank**: the field takes the item's blank ids so markers load as chips, and
  has **Insert blank**, which follows the current editor's `insertBlankAt`
  rule on the document (`lib/authoring/blankInsert.ts`: selection replaced,
  its text the first accepted answer, a space where the chip would touch a
  word, at the end when the field isn't focused); `docToMarkup` counts a chip
  in the document as a blank even before the item's list catches up. Blanks
  follow the stem's order as in the textarea. **Matching key**: re-pair by
  dragging a right onto another row or by Swap → Swap with this; both swap
  the two rows' rights only (`swapMatchRights`, `lib/authoring/keyOrder.ts`),
  announced in a live region. **Ordering key**: steps drag by a handle as
  well as Move up / Move down, announced. Tests:
  `test/authoring-fill-blank-field.test.ts` (parity with `insertBlankAt`,
  chip load / save), `test/authoring-key-order.test.ts`. Browser behaviour is
  hand-check rows 747–760. Not built: pair, step, table-cell and blank-answer
  text stay plain inputs (they take markup, as today, but not the new field);
  reordering whole matching rows (the lefts' display order); a blank chip
  shows "blank", not its number.
- 2026-10-26 — **Phase 4 slice D: `AssessmentEditor.tsx` split** (prototype
  track, no behaviour change). Moved byte-for-byte (only re-indented) out of
  the 4,181-line file: the view types and pure helpers to `editorModel.ts`
  (`ItemView`, `ItemRow`, `rowToView`, `fingerprint`, `defaultItemFor`,
  `itemPatchBody`, the scoring tables, tab ids); the Settings tab
  (`SettingsTab.tsx`) and the Allowed tab (`AccommodationsTab.tsx`); the top
  of the Questions tab — heading, preview, import panels, add / AI toolbar,
  AI proposal (`QuestionsToolbar.tsx`); the stimulus card
  (`StimulusSetCard.tsx`); and a card's per-type editor, choices included
  (`ItemTypeFields.tsx`). Each component takes the editor's own values and
  handlers as props of the same names; all state stays in
  `AssessmentEditor.tsx` (now 2,047 lines), which re-exports the moved
  helpers so existing imports keep working. Checked: a script compared every
  moved line with the original (identical apart from indentation, plus
  `export` on the model's declarations), and a throwaway server render of the
  editor before and after (draft / published × flag off / on × all five tabs,
  one question of every type and a stimulus set) produced the same HTML once
  React's generated `useId` values were masked. Typecheck and the full suite
  pass. Not split: the question card's header, stem field, scoring select and
  save row, and the stimulus-set / autosave / outline handlers, which still
  live in the editor. Hand-check rows 761–762.
- 2026-10-26 — **Phase 4 review findings fixed** (prototype track). (1) A
  History restore that failed left the old version on the card and let an
  ordinary autosave (no `restore`, so inside the 2-minute window no copy
  kept) write it over the current content. The autosaver now has
  `hold(id)` / `release(id)` (`lib/authoring/itemAutosave.ts`): a held card
  schedules nothing, so the restore's own PATCH is the only write, and a
  refused restore puts the current content back on the card as
  `changeType` already did (which now holds the card too, for the same
  race). (2) "/" typed in a MathLive `<math-field>` (graph expressions, the
  graph item's board) also opened the add menu: the event reaches the card
  with the `<math-field>` host as its target and MathLive calls
  `preventDefault` without stopping it. The card's check is now
  `slashOpensInsertMenu` + `TEXT_ENTRY_SELECTOR` in `lib/authoring/outline.ts`
  (skips `math-field` and any key already handled). Hand-check rows 763–766.
- 2026-10-26 — **Phase 5 slice A: the preview ADR** (prototype track, R-3).
  `docs/adr/0019-scripted-preview-sandbox.md`, **Proposed** (R-3 accepted;
  the ADR text not yet reviewed; Accepted needed before Phase 9's cutover).
  Revises ADR 0006 for the scripted preview only — `/preview/[id]` keeps
  0006. Posture: a fixed shell route (no content, no key) in an iframe with
  `sandbox="allow-scripts"` only (opaque origin) and `allow=""`; CSP
  `default-src 'none'`, three hash-pinned scripts (bootstrap, KaTeX,
  renderer — R-3's "renderer only" widened, none content-dependent), hashes
  computed from the served bytes, `connect-src 'none'`, `data:` images and
  fonts, `frame-ancestors 'self'`; content over a `MessageChannel` after a
  `ready` handshake checked by `event.source`, parsed by
  `DeliveryBundleSchema` before posting; a stub `messageHandlers` bridge
  whose `submit` is scored in the parent against the editor's key, result
  shown outside the frame. Seven residual risks recorded; slice B owes a
  test that no key value reaches the posted payload, and the browser rows.
  Nothing built; no hand-check rows (no UI).
- 2026-10-26 — **Phase 5 slice B: the interactive side-by-side preview**
  (prototype track, D-2, R-3, R-11; ADR 0019 still **Proposed**, its "As
  built" section records where this goes past §1–§5). With the R-12 flag on,
  the Questions tab is editor | student preview at ≥ 1280 px (page width
  widened for the flag only) and an Editor / Student preview toggle below.
  The preview is `/preview/shell` (staff + flag only, else 404) in an iframe
  with `sandbox="allow-scripts"` only and `allow=""`: a fixed document with
  KaTeX, the student's `renderer.js` / `renderer.css` (the current signed
  renderer, else `packages/renderer/dist`) and a bootstrap
  (`lib/preview/interactive/bootstrap.ts`), the three pinned by SHA-256
  hashes computed from the served bytes (`shell.ts`); CSP `default-src
  'none'`, `connect-src 'none'`, `data:` fonts and images, `frame-ancestors
  'self'`, `sandbox allow-scripts`. Content goes in over the frame's
  MessageChannel after a `ready` accepted only from our iframe
  (`protocol.ts`): a bundle built in the editor page from unsaved state by
  the student's own per-item projection — moved unchanged from
  `buildDeliveryBundle.ts` to `lib/api/deliveryItem.ts` — with sealed match /
  order ids minted per editor session and parsed by `DeliveryBundleSchema`
  (`bundle.ts`); a draft the schema refuses is listed, not fatal. Live
  refresh is debounced (600 ms); the new frame loads hidden and replaces the
  old once rendered, and answers so far ride as `saved_responses`. The stub
  bridge keeps answers in memory; **Finish and hand in** is scored in the
  editor page with `scoreResponse` (`lib/scoring/auto.ts`) against the
  editor's key (`score.ts`), shown under the preview. Scroll linking follows
  the editor's top question (can be turned off); a click in the preview
  scrolls the editor to it. Views: **Read aloud** (TTS scope on; the parent
  speaks with an on-device voice and relays word highlights — ADR 0019's
  `tts` row amended), **One question per page** (paged layout). Shell inputs
  copied from the client with drift tests: `PageShell.baseStyles`
  (`pageShell.generated.ts`, `scripts/vendor-page-shell.ts`) and
  `katex.min.js` (`lib/preview/katex.min.js.ts`,
  `scripts/vendor-katex-js.mjs`). Tests: `test/preview-interactive.test.ts`
  (key boundary for a keyed fixture of every type, protocol validation,
  sealing, scoring, speech ranges) and `test/preview-shell.test.ts` (CSP /
  hashes, drift, the bootstrap running the real renderer in the client
  harness's DOM shim, route gating). Browser behaviour, including ADR 0019
  risk 6, is hand-check rows 767–781. Not built: speech-to-text, time-limit
  strip, contrast / zoom / font views; the math read-aloud is a plain
  reading of the TeX, not the client's MathSpeech.
- 2026-10-26 — **Phase 5 review finding fixed** (prototype track). Every
  click inside a question in the preview, including clicks that answer it,
  sent `jump`, and the editor page switched below 1280 px to the Editor
  pane, so the preview could not be answered there. At 1280 px and wider each
  answer scrolled the editor, and with Follow my place on that could scroll
  the preview back. Three changes: (1) the bootstrap sends `jump` only for a
  click on a question's text (`.stem`) or on the block itself. Controls
  (form fields, labels, buttons, links, canvas, `summary`, anything
  contenteditable or with a `role` or `tabindex`) and a click that ends a
  text selection send nothing. (2) `onShowItem` now says where the request
  came from: a click in the frame only scrolls the editor, and only a
  "Question N" link under the hand-in result switches panes. (3) After a
  jump, Follow my place stays quiet for 1.5 s. Test:
  `test/preview-shell.test.ts` (the bootstrap with the real renderer).
  Hand-check row 774 amended, rows 782–783.
- 2026-10-26 — **ADR 0019 Accepted** (landing PR 4). James accepted it as
  written; the Status line and `docs/adr/README.md` say so. The Phase 5
  entries above, which say "still **Proposed**", are dated records and stay
  as written.
- 2026-10-26 — **Phase 7 slice A built** (R-8, prototype track, flag on
  only). With the flag on, a PDF import opens a full-screen review: the
  uploaded PDF on the left, drawn page by page in the browser by the pdf.js
  build inside `unpdf` (already the server's PDF reader, so no new
  dependency; the browser's own PDF viewer is the fallback, without
  boxes), and the proposals on the right. Below 1280 px a toggle shows one
  pane. Provenance: the model returns no positions, so each proposal is
  placed by its printed question number (`source_number(s)`) at the line
  that starts with that number (`lib/pdfImport/regions.ts`, anchors from
  `extractPdfLayout`). A proposal with no matching number is shown on the
  page of the one before it ("by order", no box); a scan has no text
  layer, so nothing is placed and the pane says so. Boxes and cards link
  both ways. Each proposal is triaged (`lib/pdfImport/triage.ts`): *ready*,
  *needs a key*, *check this* (the model's text changes, a type the
  import switched on its own, a stimulus paired by position, a figure not
  extracted, a shortened source; the field is ringed on the card) or
  *can't convert* (a proposal the item schema refused, now returned as
  text: choose a type for it or leave it out). The model has no
  confidence score, so these are the pipeline's own signals. "Accept all
  ready" takes the ready pile, with a stimulus set only when all its
  questions are ready; everything else is accepted one by one. Still
  propose-only. The route adds `source_numbers`, `regions`, `converted`,
  `pages` and `unconverted` to its response; with the flag off the panel
  ignores them and is unchanged. Tests: `test/pdf-import-triage.test.ts`,
  a review-fields case in `test/pdf-import-route.test.ts`. Hand-check rows
  784–795.
- 2026-10-26 — **Phase 7 slice B built** (R-10 Word only, prototype track,
  flag on only; no Drive picker). With the flag on, the import panel takes
  a `.docx` as well as a PDF, through the same route
  (`/api/assessments/[id]/items/import-pdf`) and the same review. The file
  type and the 5 MiB cap come from `lib/ai/documentUpload.ts` (the rubric
  and batch-generation document path). **Deviation, for James's review:**
  the model does not receive the file as a Converse document block. The
  server reads the `.docx` itself (`lib/docxImport/`: a minimal zip reader
  on `node:zlib` with a per-part inflate cap, and a WordprocessingML reader;
  no new dependency) and sends its text on the existing text path, because
  (1) Word's automatic list numbers live in `numbering.xml`, not in the
  text, and the review places proposals by those numbers, so the model and
  the review must read the same numbers; (2) the guardrail's input stage
  can then screen the text (record-only, as for PDFs), which the
  document-block path skips; (3) the mock provider exercises the real
  path. The left pane is a simple rendering of the document's text and
  structure from that reader (headings, list numbers, bold / italic,
  tables, a placeholder per picture), drawn as React elements from data,
  never HTML; a numbered outline surrounds the paragraphs each proposal
  covers (`locateCandidates` over a one-block-per-unit pseudo-page,
  `regionBlockRange`, `docxGroups`). Not imported: pictures (counted and
  said), text boxes, tracked deletions, field codes, footnotes, headers and
  footers, and numbering that comes from a paragraph style. A question
  numbered inside a table cell is not placed. The drop-zone tip reads
  "From Google Docs: File → Download → Microsoft Word (.docx)". Gating: the
  PDF item import has never been gated on `allow_llm_authoring` (only the
  generate / suggest surfaces are); Word import follows the PDF import,
  so it is not gated either — open question for James. Flag off, a `.docx`
  still goes to the PDF reader and is refused (`pdf_parse_failed`), and
  every PDF hint is unchanged. Tests: `test/docx-document.test.ts`,
  `test/docx-import-route.test.ts` (hand-built `.docx` fixtures,
  `test/helpers/docx.ts`; mock provider). Hand-check rows 796–803.
- 2026-10-26 — **Phase 7 slice C built** (R-9, D-6, prototype track, flag
  on only). Choosing a `.json` on **Import assessment file** now shows what
  the import will create before anything is written: the new name (the
  import's own `title (copy)` rule), questions by type, passages, pictures,
  layout, calculator, accommodations, a warnings list (unknown types left
  out, scoring settings the import clamps, accommodations off the catalog,
  E12 source links dropped, pictures the file lacks, questions with no key)
  and the questions in the student's own renderer (Phase 5's sandboxed
  frame, Follow my place hidden, pictures sent in from the file). **Create
  assessment** submits the same file to the same server action as before.
  To keep the preview from drifting from the import, the import's pre-write
  work moved unchanged into a pure `planImport` (accommodation clamp, type
  skip, graph check, every row as stored) plus `importName` and
  `keptSourceItemId`, and the request body reading into
  `lib/api/importBody.ts`; the import and the new read-only route
  `POST /api/assessments/import/preview` (404 with the flag off) both use
  them. Tests: `test/import-preview.test.ts` (counts, warnings, refusals,
  no key in the student view, no row written by the preview or its route,
  and the preview equal to what the import then stores). Flag off: the
  direct import, unchanged. Hand-check rows 804–810.
