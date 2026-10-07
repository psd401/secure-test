# RT — formatting in a student's essay (bold, italic, underline, undo, indents)

Design page, 2026-10-07. Source: an open-beta teacher asked for students
to be able to bold, underline or italicize their own writing. Decisions
marked **D-n** are James's (D-1…D-8, all 2026-10-07). Nothing is built.

## Decided (James, 2026-10-07)

- **D-1 A per-essay checkbox.** The teacher turns formatting on for one
  essay question: "Let students format their answer". It is off by
  default, so every existing essay is unchanged.
- **D-2 Bold, italic, underline, undo and indents.** No lists, headings,
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
  `data-indent="first"`, D-4), `<br>`, `<strong>`, `<em>`, `<u>`.
  Nothing else, no attributes but `data-indent`.
- **The server re-cleans `html` and derives `text` from it.** The stored
  `text` is always the plain reading of the stored `html`, so word count,
  scoring, safeguarding and history cannot disagree with what the teacher
  sees. A response without `html` is a plain essay, as today.
- Answer history keeps `html` with each kept version.

**Student side (client).**
- When `rich_text` is on, the essay box is an editable rich-text area
  (`contenteditable`) instead of a textarea, with a small toolbar above
  it: **B**, *I*, U, Indent first line (a toggle on the current
  paragraph or paragraphs), Undo, Redo. Each button is a keyboard stop
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
   page, the work packet and the Google Docs release.
3. Client: the rich box + toolbar + shortcuts + own undo stack + clean
   paste; autosave, prefill, spool and spell check carried over; the same
   undo stack on plain essays, short answers and table cells (D-6).
4. Client: "Read my answer" over the rich box; VoiceOver labels and
   pressed states; rows. Ships in v1.6.0.

## Open questions

None. All decided 2026-10-07 (D-1…D-8).
