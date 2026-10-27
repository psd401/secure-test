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
