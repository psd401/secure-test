# RT — formatting in a student's essay (bold, italic, underline, undo, indents)

Design page, 2026-10-07. Source: an open-beta teacher asked for students
to be able to bold, underline or italicize their own writing. Decisions
marked **D-n** are James's (D-1…D-10, all 2026-10-07). Slices 1–2 are built (see §Progress).

## Decided (James, 2026-10-07)

- **D-1 A per-essay checkbox.** The teacher turns formatting on for one
  essay question: "Let students format their answer". It is off by
  default, so every existing essay is unchanged.
- **D-2 Bold, italic, underline, undo and indents** (lists added by D-9). No headings,
  fonts, colors, links or images.
- **D-3 Ships in client v1.6.0** with fill in the blank
  (`docs/fill-in-blank-design.md`). v1.5.1 is skipped.
- **D-4 Indent = MLA-style first-line indent, for now (13.1).** A
  paragraph is either first-line indented or not. No block indents or
  levels.
- **D-5 Tab keeps moving focus (13.2).** Indent by the toolbar button or
  Cmd-] / Cmd-[; no keyboard trap.
- **D-6 Undo everywhere students type (13.3).** The page's own undo /
  redo stack also serves plain essays, short answers and table cells.
  This closes ME-2 for text fields. Plain fields get Cmd-Z / Shift-Cmd-Z
  only; the formatted essay also has Undo / Redo buttons.
- **D-7 Word count and the word limit read `text` (13.4)**, so formatting
  never counts.
- **D-8 The teacher preview shows the toolbar (13.5)** so a teacher can
  try formatting before publishing.
- **D-9 Bulleted and numbered lists, one level (14.2).** Added after more
  teacher requests. No nesting (nesting would need Tab, and D-5 keeps Tab
  for focus). Toolbar buttons plus Shift-Cmd-8 / Shift-Cmd-7. In the
  derived `text`, items read as "• " / "1. " lines, so scoring and word
  count see the structure.
- **D-10 Double-spacing is a teacher-side display choice (14.3), default
  off.** It is not part of the student's answer. A "Double-space essays"
  option on the work packet print and in the Google Docs send dialog
  (the Doc carries line spacing 2.0, so it stays double-spaced when
  edited). It applies to every essay, formatted or not, and needs no
  client change. Students type at normal spacing.

## What exists that this stands on

- **The essay answer is plain text.** `EssayResponseSchema` is
  `{type: "essay", text}`. Word count, AI scoring, the safeguarding
  classifier, answer history (U-19), instant feedback, the work packet
  and the Google Docs release all read `text`.
- **The client's essay box is a `<textarea>`**
  (`client/…/AssessmentPage.swift`). Several features are built on it:
  autosave (5 s idle / 30 s ceiling), resume prefill, the spell-check
  grant (`area.spellcheck`), the deferred spool, and the "Read my answer"
  word highlight, which lays a mirror over the field and maps offsets
  into its value (`ttsMirrorFor`).
- **There is no undo in text fields today.** Finding ME-2 (accepted
  2026-09-23): Cmd-Z beeps because the Edit menu has no Undo. The
  drawing canvas has its own Cmd-Z.
- **Tab moves focus.** The v1.3.5 keyboard-reach work makes every
  control a Tab stop. A Tab that indents inside the essay would break
  that, and would trap keyboard users (WCAG 2.1.2).
- **The Google Docs release already uploads HTML** that Drive converts
  (`lib/googleDocs/content.ts`), so formatting can carry into the Doc.
- **Unknown fields are ignored by older clients.** The Swift decoder
  skips keys it does not know, so a `rich_text` flag on an essay reaches
  a v1.5.0 client as a plain essay. Unlike fill in the blank, this needs
  **no version gate**: an older client shows the plain box and the
  answer still saves as text.

## Proposed shape (for review)

**Item.** `items.config.rich_text: true` on an essay (teacher bundle and
delivery bundle both carry it; it is not a key). An editor checkbox under
the essay's word-limit field: "Let students format their answer (bold,
italic, underline, indents)".

**Response.** `{type: "essay", text, html?}`.
- `html` is a small, fixed subset: `<p>` (optional
  `data-indent="first"`, D-4), `<br>`, `<strong>`, `<em>`, `<u>`,
  `<ul>` / `<ol>` with `<li>` one level deep (D-9). Nothing else, no
  attributes but `data-indent`.
- **The server re-cleans `html` and derives `text` from it.** The stored
  `text` is always the plain reading of the stored `html`, so word count,
  scoring, safeguarding and history cannot disagree with what the teacher
  sees. A response without `html` is a plain essay, as today.
- Answer history keeps `html` with each kept version.

**Student side (client).**
- When `rich_text` is on, the essay box is an editable rich-text area
  (`contenteditable`) instead of a textarea, with a small toolbar above
  it: **B**, *I*, U, Bulleted list, Numbered list, Indent first line (a
  toggle on the current paragraph or paragraphs), Undo, Redo. Each button is a keyboard stop
  and announces its pressed state.
- Shortcuts: Cmd-B / Cmd-I / Cmd-U, Cmd-] / Cmd-[ to add / remove the
  first-line indent, Cmd-Z / Shift-Cmd-Z for undo / redo. **Tab keeps
  moving focus** (D-5).
- **Undo is the editor's own** (a snapshot stack in page JS, like the
  canvas), not the Edit menu, so it works inside lockdown without
  touching ME-2's menu decision.
- **Paste is cleaned**: only the subset above survives (pasting inside
  the test is already the only source).
- Autosave, resume prefill, the deferred spool and the spell-check grant
  carry over to the new box.
- **"Read my answer" needs rework.** The textarea mirror maps offsets
  into a plain value. Over a rich box it can read the text and
  highlight through ranges directly, which is simpler than the mirror,
  but it is a real change and needs its own rows.

**Teacher side (design-tool).** Show the formatting wherever the essay is
shown: scoring queue, per-student page, work packet (print), answer
history's "Earlier versions", and the Google Docs release. The cleaned
`html` is rendered through one sanitising renderer. AI scoring,
safeguarding, insights and word count keep reading `text` (D-7). The
preview renders the toolbar and a working box (D-8).

## Slices (after the open questions)

0. This note + decisions.
1. Server: the `rich_text` flag (editor checkbox, both bundles), the
   `html` field on the essay response, the sanitiser + `text`
   derivation at ingest, answer history carrying `html`.
2. Teacher read side: one renderer, used by the queue, the per-student
   page, the work packet and the Google Docs release; the "Double-space
   essays" option on print and the Docs send (D-10, default off). The
   double-spacing half can ship on its own with any design-tool deploy.
3. Client: the rich box + toolbar + shortcuts + own undo stack + clean
   paste; autosave, prefill, spool and spell check carried over; the same
   undo stack on plain essays, short answers and table cells (D-6).
4. Client: "Read my answer" over the rich box; VoiceOver labels and
   pressed states; rows. Ships in v1.6.0.

## Open questions

None. All decided 2026-10-07 (D-1…D-8).

## Progress

### Slice 1 — the flag and the server (BUILT 2026-10-07, not deployed)

- **Item flag.** `rich_text?: boolean` on the essay in `ItemBundleSchema` and
  `DeliveryItemSchema` (packages/schema), on the write boundary
  (`lib/api/items.ts` `EssayItem`) and in `ItemConfig`. Stored only when
  true (`itemConfigForWrite`), so existing rows and exports stay
  byte-stable; a non-essay body's `rich_text` is stripped like any unknown
  key (not refused). Export, import (so Duplicate and share-accept too) and
  the delivery bundle carry it only when on; no version gate (an older
  client ignores the field). The publish lock refuses a change to it:
  `isAnswerKeyOnlyPatch` compares config whole and `rich_text` is not a key.
  Editor: the checkbox under Max word count, disabled while Published.
- **Response.** `EssayResponseSchema` gains `html?: string`, capped at
  `ESSAY_HTML_MAX_LENGTH` = 200 000 characters; `text` stays required.
- **Sanitiser + text** (`design-tool/lib/richText/essayHtml.ts`, hand-rolled,
  no dependency). Tokenizer → small tree → normalised blocks
  (paragraphs and one-level lists of marked text runs) → serialised from
  scratch, so no client markup is ever copied through. Kept: `<p>` (only
  `data-indent="first"`), `<br>`, `<strong>`, `<em>`, `<u>`, `<ul>`, `<ol>`,
  `<li>`. Mapped: `<b>`→strong, `<i>`→em, `<span>`/`<font>` styles
  (font-weight bold / ≥ 600, font-style italic / oblique, text-decoration
  underline) → marks, `<div>` / headings / other blocks → paragraphs
  (`<div>` keeps the indent), a nested list's items join the outer list,
  a block inside an item → `<br>`, a stray `<li>` → paragraph, loose text →
  paragraph. Dropped with content: script, style, iframe, svg, math, img,
  input, video, audio, template, object, select … ; comments, doctype and
  `<?…?>` vanish; anything else is unwrapped. Canonical mark nesting
  (strong > em > u), adjacent runs merged, empty list items dropped,
  leading / trailing blank paragraphs dropped (an inner one is kept as
  `<p><br></p>`, an empty line). Idempotent; nesting deeper than 64 is
  unwrapped.
- **Text (D-7).** One line per paragraph joined by a single `\n` (a
  contenteditable makes every Enter a paragraph, so this is what a textarea
  would hold for the same keys; a blank paragraph is an empty line); `<br>`
  is `\n` except a block's single trailing placeholder; list items read
  "• " / "1. ", numbered within their list (D-9); the indent adds nothing;
  entities decoded, no-break spaces read as spaces, source whitespace
  collapses as it renders.
- **Ingest** (`essayResponseForStorage`, called in
  `PUT /api/attempts/[attemptId]/responses/[itemId]` after unsealing and
  before answer history): `rich_text` on + `html` → the cleaned html and
  the DERIVED text (the client's text is overwritten); cleans to nothing →
  `{text: ""}` with no html; `rich_text` on, no html (an older client) →
  stored as sent; `rich_text` off → html dropped.
- **History.** `response_revisions.response` is the jsonb whole, so a kept
  version carries its html and Restore writes it back — tested both ways.
  Every reader of `text` (scoring, safeguarding, insights, Docs, work
  packet, instant feedback) is unchanged; nothing renders `html` yet
  (slice 2).
- Tests: `test/rich-text-essay-html.test.ts` (sanitiser table, text,
  ingest), items API (stored only when on, stripped elsewhere, publish
  lock, export/import), delivery bundle, the response PUT (four ingest
  cases + history), restore. Rows 526–533 in
  `docs/design-tool-manual-checks.md`, NOT RUN.

### Slice 2 — the teacher read side and double-spacing (BUILT 2026-10-07, not deployed)

- **One renderer** (`design-tool/lib/richText/renderEssayAnswer.ts`).
  `essayRichHtml(response)` re-cleans a stored essay's `html` with
  `sanitizeEssayHtml` AT RENDER (a stored row may predate a sanitiser fix) and
  returns null for a plain essay (no `html`, a non-essay, or html that cleans
  to nothing). `renderEssayAnswerHtml(response)` wraps formatted html in
  `<div class="essay-rich">`; a plain essay comes back as its escaped `text`
  with the newlines left in, so each surface's own `pre-wrap` / `pre-line`
  container shows it exactly as before. CSS in `app/globals.css`:
  `white-space: normal` (undoes the containers' pre-wrap), paragraphs with no
  margin (each Enter is a paragraph, so this spaces the answer the way the
  same keys spaced a textarea), `p[data-indent="first"]` `text-indent: 2em`,
  disc / decimal lists with 1.75em padding (preflight strips markers).
- **Surfaces.** Scoring queue: the review-queue route adds `essay_html`
  (formatted essays only; null otherwise, so a plain card is unchanged) and
  `ScoringQueue.tsx` renders it in the card's box. Per-student page: the
  essay answer and every "Earlier versions" entry go through the renderer;
  **Copy** still copies `revisionText` = the plain `text` (D-7, tested). Work
  packet: essays print in a `<div class="answer-text">` (was a `<p>`; a
  formatted answer holds paragraphs and lists) through the renderer. Google
  Docs: `release.ts` sets `EssaySection.answer_html` from `essayRichHtml`;
  `content.ts` `docRichAnswerHtml` maps the sanitiser's canonical output tag
  for tag (safe because text is already escaped and the tag set is fixed):
  `<p>` → no margin (the student's own blank paragraphs space it),
  `data-indent="first"` → `text-indent:36pt` (half an inch, MLA),
  `strong` / `em` → `b` / `i`, `u` / lists kept. Left on `text` (D-7):
  instant feedback (client-rendered), AI scoring, safeguarding (incl. the
  queue's evidence quote), insights, word count, the CSV.
- **Double-spacing (D-10, default off).** Work packet: `?spacing=double`
  (`PacketQuery.doubleSpace`; any other value is single; kept by Select all),
  a "Double-space essays" checkbox in the toolbar (unchecked submits nothing,
  so no hidden field), class `answer-double` → `line-height: 2` on essay
  answers only, plain and formatted. Google Docs: a "Double-space essays"
  checkbox in the send dialog (`DialogState.doubleSpace`, saved across the
  Google redirect; an older saved state reads as off), `double_space`
  (optional boolean) on the POST, `ReleaseOptions.doubleSpace`,
  `DocInput.doubleSpace` → `line-height:2.0` on the essay's paragraphs (plain:
  `<p style="margin:0 0 10pt 0;line-height:2.0">`; formatted: on every `<p>`
  and `<li>`). Prompt, sources and feedback keep normal spacing. That Drive
  turns `line-height:2.0` into Double line spacing is the form Docs' own HTML
  export uses — **unverified against Drive** until row 540.
- **Help.** `public/help.html` topic 9's Print student work line mentions
  double-spaced essays (text only). The help page has no Google Docs topic,
  so nothing there for the dialog.
- Tests: `test/rich-text-essay-render.test.ts` (renderer: formatted / plain /
  re-cleaned / cleans to nothing; Docs mapping single and double; buildDocHtml
  spacing only on essays; Copy stays plain), the packet query and page
  (formatted re-cleaned, plain unchanged, `spacing=double` on both essays and
  nothing else, the toolbar box), the per-student page (answer + earlier
  version), the review queue payload, the Docs release (formatted Doc, double
  spacing) and route (`double_space` reaches the upload; a non-boolean is
  400), the dialog's saved state. Rows 534–541 in
  `docs/design-tool-manual-checks.md`, NOT RUN.
