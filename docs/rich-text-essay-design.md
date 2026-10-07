# RT — formatting in a student's essay (bold, italic, underline, undo, indents)

Design page, 2026-10-07. Source: an open-beta teacher asked for students
to be able to bold, underline or italicize their own writing. Decisions
marked **D-n** are James's (D-1…D-10, all 2026-10-07). Slices 1–4 are built (see §Progress).

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

### Slice 3 — the client: formatted box, toolbar, undo everywhere (BUILT 2026-10-07, not released)

- **Core.** `EssayItem.richText` (decodes `rich_text`, false when absent);
  `ItemResponse.essay(text:html:)` with `html` optional — absent on the wire
  when nil, so a plain essay posts exactly what it did.
- **The rules, ported** (`AssessmentPageRichText.swift`, `richTextFunctions`,
  spliced into the renderer like the math pass). The server's tokenizer, tree,
  normaliser, tidy, serialiser and D-7 text rule in page JS, plus a reader that
  walks the LIVE box as the same tree. The box is read through them on every
  change, so the page posts the canonical subset and derives `text` the
  server's way; the box is written only from canonical blocks built as DOM
  (restore, undo / redo, the one-level repair) — never from markup, so the
  renderer still has no `innerHTML`. The headless suite runs the server's own
  sanitiser and text tables against this code.
- **The box** (`richEssayField`, only when `rich_text` is true). A
  `contenteditable` `role="textbox"` `aria-multiline`, named "Your answer"
  (the textarea is named only by its placeholder, which a div lacks), the
  placeholder painted from `data-placeholder` while empty, spell check on the
  per-student gate as an attribute, selection re-enabled inside it (the page
  turns selection off outside fields). WebKit's `defaultParagraphSeparator`
  is `p` and `styleWithCSS` false, so Enter makes a paragraph (one line of
  `text`, D-7) and B / I / U make elements.
- **Toolbar** (`role="toolbar"`, "Formatting"): Bold, Italic, Underline,
  Bulleted list, Numbered list, Indent first line, Undo, Redo; the six toggles
  carry `aria-pressed` (WebKit's `queryCommandState` for B / I / U / lists,
  the paragraph's attribute for the indent), Undo / Redo `aria-disabled`.
  **One Tab stop** with Left / Right / Home / End inside it — the keypad's and
  the drawing strip's pattern (D-3.1 / 4b-f) — rather than eight stops; a
  pointer press keeps focus and the selection in the box. Shortcuts on the box:
  Cmd-B / I / U, Shift-Cmd-8 / 7 (D-9), Cmd-] / Cmd-[ (D-4), Cmd-Z /
  Shift-Cmd-Z. **Tab is never handled (D-5).**
- **Commands.** B / I / U and lists are WebKit's `execCommand`. The indent
  toggles `data-indent="first"` on the top-level paragraphs the selection
  touches (a loose line is wrapped in a `<p>` first, only for the command).
  D-9: any nested list — whatever made it — is flattened back to one level
  on the next `input`, caret kept by position.
- **Undo (D-6).** `undoHistory(capture, apply)`: keystrokes coalesce into one
  step until a 1 s pause or a word boundary (whitespace / punctuation /
  Enter / paste), a formatting command or a keypad key is a step of its own,
  200 steps deep. The box's history holds canonical html + the caret as a
  character position; plain fields hold value + selection. An undo / redo
  runs the field's own `oninput` (word count, preview, read-aloud /
  dictation stop) and then saves AT ONCE through the field's flush — a
  programmatic value change fires no `change` on blur (the keypad's D-3.2
  trap). Plain fields — essay textarea, short text, table cells, typed
  blanks, the E12 outline — get it through `textAutosave` (Cmd-Z /
  Shift-Cmd-Z only, no buttons). The math keypad records its insertion as a
  step, so it is undoable and the undo is posted. The canvas's Cmd-Z is
  scoped to its item's wrap and unaffected. No Edit-menu Undo was added
  (ME-2 stands).
- **Paste and drop.** Paste is intercepted: refused outright while the
  clipboard is locked (slice 69 — the box must not be a back door), otherwise
  only `text/plain` is read and inserted as typing (`insertText`, a paragraph
  per line), so it takes the formatting at the caret and nothing from the
  source. **Drop is refused** and formatted text cannot be dragged out — not
  "insert the drop as plain text": that would need the drag payload, and the
  page keeps no HTML5 drag path at all (S-1's guard test).
- **Carried over.** Autosave (5 s / 30 s, flush on blur — a contenteditable
  fires no `change`, so blur is the change — page turn, Finish, the host's
  pre-teardown flush) compares canonical html, so a bold-only change saves;
  the deferred spool and offline relabel are unchanged (the same `post`).
  Resume restores `html` when present, else one paragraph per saved line;
  nothing is posted at load and the restored answer is the undo baseline.
  The word count reads the derived text without list markers (a "•" or "1."
  is not a word the student wrote). The answered mark is the plain essay's
  (any post). An emptied box posts `{text: ""}` with no `html` — what an
  emptied textarea posts (it has never withdrawn). The closing math pass and
  the question's read-aloud skip the box, as they skip a textarea.
- **Read aloud / dictation, degraded until slice 4.** "Read my answer" reads
  the derived text with no word highlight (the mirror maps textarea offsets
  and has nothing to map here). "Speak my answer" inserts each phrase at the
  box's caret as typing; its spacing context is the END of the text, so a
  phrase dictated mid-paragraph may be spaced as if at the end.
- Tests: `RendererRichTextTests` (31: decode / encode; the server's two
  tables; DOM reader = markup reader; render with and without the flag; spell
  check; autosave of html + text; blur; bold-only change saved; empty;
  shortcuts and buttons → commands with stubbed `execCommand`; Tab and other
  keys untouched; indent with a stubbed selection; nested-list repair; paste
  plain / refused; undo / redo in the box incl. a command step and the
  buttons; restore of html and of plain text; read-aloud without a mirror;
  undo in short text (coalescing, boundary, cap), keypad, table cell, plain
  essay, typed blank). JSC has no editing engine, selection or
  contenteditable, so what WebKit's commands really emit, the caret after an
  undo, and the chords under AAC are hand-run rows: "Formatting in essays +
  undo (v1.6.0, RT slice 3)" in `client/MANUAL-CHECKS.md`, NOT RUN.

**Slice 3 look (main session, 2026-10-07, Debug client, offline fixture
copy with `rich_text` on, no lockdown):** toolbar renders with pressed
states; typing, Bold, Return, Bulleted list, Undo (twice), and Indent
all behave. Two quirks, proposals only: **RT-1** the first Undo left an
empty paragraph between the first line and the list (the second Undo
removed the list and the gap); **RT-2** the caret lands by character
offset after Undo / Indent (seen mid-word: "bold |part"), as the agent
flagged. Neither loses text. Shortcuts under real AAC remain the main
unknown (rows in client/MANUAL-CHECKS.md).

### Slice 4 — read aloud, dictation, VoiceOver, RT-1 / RT-2, the preview toolbar (BUILT 2026-10-07, not released / not deployed)

- **"Read my answer" over the box, with the word highlight.** No mirror: the
  box is real DOM with `user-select: text`, so a spoken word is a CSS Custom
  Highlight range on the box's own text node. `richSpeechSegments(box, split)`
  (pure, in `richTextFunctions`) reads the box as segments in the D-7 line
  order — each text node as itself (`node`, `start`, `raw`; `$…$` split by the
  page's `mathSegments` into a math segment marked whole), "\n" between lines,
  and each list item's "• " / "1. " as a SAID segment. **Markers are spoken**
  (the voice says the bullet / number, as the derived text always read) but
  carry no node, so nothing is highlighted while one is said; empty lines are
  not read; numbering counts only items with text, like the derived text.
  `richSpeechRange(seg, offset, length)` (pure) maps the host's word (offset in
  the segment's spoken text) back to `{node, start, end}` — `\$` spoken as `$`
  mapped past the backslash, a word clamped to its node. `ttsHighlight` takes
  that path for segments tagged `box`, then `ttsBoxReveal` scrolls the box
  (overflow-y: auto) to keep the word in view; the stale-paint `ttsRepaint`
  toggle runs on the box (the reading target). Kept: typing stops reading
  (`ttsStopWhenTyping` on the box), the highlight and outline clear at the end
  and on Stop, "No answer yet." for an empty box. A word split across two
  nodes (`<b>bo</b>ld`) highlights only its first node's part — the question
  reader's existing behaviour.
- **Speak my answer, spaced at the caret.** `richCaretContext(box, …)` (pure)
  reads the box as `richLinearText` — one string whose index IS a caret
  position (text characters, "\n" for every `<br>` and paragraph / item
  boundary) — and returns up to 16 characters before the selection's start and
  the one after its end; the host's existing spacing rule then gives a
  mid-paragraph phrase the right spaces and capitalises after a paragraph
  boundary. A box with no caret (never focused): the context is the end, and
  `__richInsert` now puts the caret at the end before inserting (WebKit would
  have put it at the start).
- **Accessibility.** Already there from slice 3 and kept: `role="toolbar"`
  named "Formatting", every button named, `aria-pressed` on the six toggles,
  `aria-disabled` on Undo / Redo, the box `role="textbox"` `aria-multiline`
  "Your answer", one Tab stop for the strip. Added: the box is
  `aria-describedby` its word count (when the essay has a limit) and the
  toolbar `aria-controls` the box.
- **RT-1 — cause found, fixed.** WebKit's list command can leave the paragraph
  it converted behind as an empty `<p>` with no `<br>` — zero height, so the
  student never sees it — and the DOM reader read it as an inner blank
  paragraph, i.e. `<p><br></p>`, which an undo rebuilt as a visible empty line
  (the second undo went to a state before the list, where a trailing blank is
  dropped — exactly the look's sequence). `richInvisibleBlock` (a `p` / `div`
  with no `<br>` and no non-collapsible text) is skipped by the DOM reader and
  by the caret walk, so it is neither saved nor counted. The MARKUP reader is
  unchanged, so the shared server table still holds. This also explains part
  of RT-2: positions after the gap were off by one in the rebuild.
- **RT-2 — fixed for the stale caret.** An undo restored the caret recorded
  with the TARGET state's last edit, so a caret moved since (a click, a
  selection made for a command) was ignored. `undoHistory` gains `moved()`:
  on every `selectionchange` inside the box the current state takes the new
  caret and the typing step closes, so an undo puts the caret / selection back
  where the undone change was made, and typing elsewhere after a click is a
  step of its own. The flat character position stays (with RT-1's skip it
  matches the rebuild); a `(block, offset)` path was not needed. Plain fields
  are unchanged (they do not call `moved`).
- **D-8 preview toolbar — partial by design.** The preview page runs no script
  (CSP `default-src 'none'`, no `script-src`, ADR 0009), so the buttons cannot
  run commands: they render inert (`aria-disabled`, the Tier-1 toolbar's
  pattern) with a note "Students can format their answer here with these
  buttons. In this preview, type in the box and try Cmd-B, Cmd-I or Cmd-U;
  nothing is saved." The box IS a working `contenteditable` (no script needed
  to type; the browser's own Cmd-B / I / U work in it), styled like the
  client's (paragraphs without margin, the first-line indent and list styles).
  The preview route passes `rich_text` (essays only); print mode keeps the
  blank write area. Lists, indent and undo cannot be tried in the preview.
- Tests: `RendererRichTextTests` 31 → 44 (13 new, the slice-3 read-aloud test rewritten; segments = the derived lines; a word →
  its node incl. `\$` and clamping; a formula whole; caret context mid-word /
  paragraph start / selection / no caret; RT-1 skip in reader and positions;
  `moved()` keeps the caret and closes the step, an unmoved caret keeps
  coalescing; the page: lines read without a mirror, word highlighted in a
  `<strong>` and an `<li>`, marker not, clear at the end; typing stops reading;
  empty box; dictation context at the caret and to the end when unfocused;
  toolbar / box names and links; undo puts the selection back on "bold").
  `preview-render.test.ts` +2 (toolbar + editable box, no script; print keeps
  the write area). Rows: client/MANUAL-CHECKS.md "Formatting in essays — read
  aloud, dictation, VoiceOver (v1.6.0, RT slice 4)" (18), design-tool rows
  542–546; NOT RUN. The slice-3 "Read my answer (degraded)" row is marked
  superseded.

**Slice 4 look (main session, 2026-10-07, Debug client rebuilt from the
slice-4 tree, same sequence as the slice-3 look):** **RT-1 and RT-2 are
NOT fixed in WebKit.** The first Undo after Bold → Return → Bulleted list
→ "first item" still shows an empty line between the first paragraph and
the list; Indent after two Undos still puts the caret mid-word ("bold
|part" from "part|"). The slice-4 causes were inferred from code; the
real WebKit DOM was not seen. Next step: inspect the box's DOM in WebKit
(the Debug web view is not inspectable today) before another fix.

**RT-1 / RT-2 FIXED 2026-10-07 (main session), verified in the Debug
client.** A Debug-only File → "Dump Formatting Box to Log" (host-run
`evaluateJavaScript`, nothing added to the page's bridge, absent in
Release with the rest of the File menu) showed the real WebKit DOM:
- **RT-1 cause:** WebKit's list command leaves the list INSIDE the
  paragraph it started in — `<p>…</p><p><ul><li>first item</li></ul></p>`.
  Both the server sanitiser and its client port turned the empty wrapper
  into `<p><br></p>`, so the saved html / text carried a blank line the
  student never typed, and an undo rebuilt it visibly. **Fix:** a
  `<p>` / `<div>` that held a list or block and no text of its own emits
  no paragraph (server `holdsStructure`, client `richHoldsStructure`); a
  typed blank paragraph (`<p><br></p>`, `<p></p>`) stays. The client's
  position counter treats such a wrapper as no line (`richListWrapper`).
  A live repair of the wrapper was tried and REMOVED: right after the
  list command the new item is empty, the rebuild tidied the empty list
  away and the typing landed in the first paragraph.
- **RT-2 cause:** after an undo the caret was restored on the box itself
  (`box @ 1`), outside every paragraph; the "mid-word" caret after Indent
  was that caret painted at its old x while the text moved 2em right.
  **Fix:** `richPointAt` falls back to the end of the last text before
  the target instead of a box-level boundary.
- Re-run of the same sequence: no blank line after Undo; after two Undos
  + Indent, a typed "X" lands at the end ("bold partX"); the dump shows
  `<p data-indent="first">Plain start <strong>bold partX</strong></p>`
  with the caret inside the text. Tests: three cases added to the shared
  sanitiser table (server) and both client tables.

**Non-lockdown hand-run 2026-10-07 (main session, local `_demo`).**
Design-tool rows 526–531, 533–535, 537, 538, 541, 543–545 ✅ (536 / 542 in
part; 539 / 540 need a real Google Docs send with James's consent, 546
VoiceOver). Client (Debug, simulated lockdown, against the local server):
Cmd-B / Cmd-] / Shift-Cmd-8 apply and the autosave stores clean html with
the derived text; resume restores the formatting; Tab leaves the box;
Cmd-Z in a typed blank undoes and posts. Readings, proposals only:
- **RT-3 FIXED 2026-10-07**: dimmed (opacity 0.5, not-allowed cursor). Was: the preview's inert toolbar LOOKS clickable (opacity 1, normal
  colour) — dim it.
- **RT-4 FIXED 2026-10-07**, checked in the Debug client: lists reset `text-indent`, and a paragraph that only wraps a list is not one the indent applies to (Indent no longer reads pressed there). Was: Return after a first-line-indented paragraph copies the indent
  onto the next block (WebKit copies the attribute), so a list item started
  there LOOKS indented and Indent shows pressed; the saved html carries no
  indent on the item and a resume shows it correctly. Carrying the indent
  to the next paragraph is the MLA behaviour; only the list case is off.
- A stale Turbopack dev cache served the pre-slice `globals.css` (no
  `.fb-*` / `.essay-rich` rules) until `.next` was moved aside — dev only,
  the build is unaffected.
