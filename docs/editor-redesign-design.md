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

## Phases

Each phase is its own PR or PR series; one commit per slice.

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

Phases 3–4 and 7 can run in parallel once 1 is done; 5 needs 2 and 3;
6 needs 2.

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
