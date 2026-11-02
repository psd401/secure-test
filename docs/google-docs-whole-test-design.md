# Whole test to Google Docs — design note

Roadmap row U-25, slice 4. Side: design-tool only (no client change, no
renderer, no migration). Extends the GD release
(`docs/google-docs-release-design.md`), which puts a student's essays and
short answers in one Google Doc. Slices 1–3 of U-25 (bulk pass back,
attempt 1 vs latest, corrections) are recorded in
`docs/bulk-pass-back-and-corrections-design.md` on their own branch; this
slice does not depend on them (U-25 D-30).

## Decisions (James, 2026-11-02)

U-25's own numbering:

- **D-11** The Doc carries the student's answers and approved scores only,
  never correct answers or keys.
- **D-12** Choice items list every option with the student's choice marked.
- **D-13** A passed-back student's Doc shows the latest attempt.
- The GD rules hold: final scores only, the skips (open safeguarding alert,
  no email, not handed in unless drafts are included), one Doc per student
  per assessment, `drive.file` only.
- Drawings and hotspot pictures go in as images where Drive's HTML import
  allows it.

Answers to the plan's questions (2026-11-02):

- **1.1** Hotspot: the picture, then "You picked N areas" — no marks drawn
  on the picture (regions have no labels, and marking a picture needs an
  image library). Accepted for now; may change later.
- **1.2** Graph answers: in words (the work packet's `graphAnswerLines`,
  e.g. "y = 2x + 1"), no picture — there is no server-side graph renderer
  (headless Chrome hangs here, ADR 0013). Same caveat as 1.1.
- **1.3** A whole-test Doc always carries the question text (stems and set
  stimuli): answers without their questions read as nothing. Sources stay
  a box.
- **1.4** The "Whole test" choice is not remembered between sends.
- **1.5** Pictures in questions, options and stimuli go in as images too.
- **1.6** A passed-back student who has not handed in again is skipped as
  "not handed in" unless drafts are included; then the Doc shows their
  work as it stands, marked Draft (GD D-12).

## What already gives D-13

A pass back reopens the same attempt, so its responses are the latest
answers, and `buildFeedbackRelease` already ignores superseded scores. A
re-handed-in attempt is `submitted` again and released like any other.

## Layout per item type

Each question is a "Question n" heading, its stem (math as its LaTeX
source, R-5), then the student's answer, then the score and feedback
blocks the boxes ask for (FR R-3, unchanged).

| Type | In the Doc |
|---|---|
| Essay, short answer | As today |
| Multiple choice (single / multi) | Every option, ☑ chosen / ☐ not (D-12) |
| Match | Each left item → the right item the student put beside it, "(none)" when unmatched |
| Order | The student's order, numbered |
| Fill in the blank | The sentence with the student's answers in brackets; blanks no marker places listed after |
| Table | The grid with the student's cells, "—" when empty |
| Graph | The objects placed, in words (1.2) |
| Hotspot | The picture, then "You picked N areas" (1.1) |
| Drawing | The student's drawing as a picture (reference picture with the stem) |
| Unknown | "Answer saved" |

**D-11 by construction:** the renderer's input type for a question has no
field that can hold a key (the ADR 0016 idea) — the mapping from item and
response drops `correct_choice_ids`, `correct_answer`, `cell_keys`, a
blank's keys and correct option, `correct_region_ids`, `graph_key`, and
never marks ✓ / ✗. A match's pairing and an order's sequence ARE their
keys, so only the student's own arrangement is shown. AI feedback is held
back on every type except essays (it can restate a key; FR withholds it
on short answers for that reason).

## Images

Our image URLs need a staff sign-in, so Google cannot fetch them; the
only route is an `<img src="data:…;base64,…">` inside the uploaded HTML.
Drive's multipart upload takes at most 5 MB, so pictures are added until
the Doc's HTML would pass a 4.5 MB budget, and any after that become a
line of text ("[Picture not included: the Doc's size limit]"). A picture
that cannot be read becomes "[Picture]" with its alt text. Whether
Drive's import keeps embedded pictures is checked on a live send (rows
below) before the slice is called done.

## Slices

0. This note.
1. Renderer (`lib/googleDocs/content.ts`, `wholeTest.ts`): the per-type
   answer views, pure, with a key-leak test.
2. Send path: `whole_test` in the route body, every item read, `no_answers`
   skip, the dialog box, the button on any test with questions.
3. Images: data URIs under the budget, text fallback.
4. Help page, manual-check rows, roadmap.

## Progress

- 2026-11-02 — note written; nothing built.
- 2026-11-02 — slices 1–4 BUILT on branch `claude/confident-lehmann-8fdd2d`
  (not pushed, not deployed). 1: `lib/googleDocs/wholeTest.ts` + the
  renderer, with a key-leak test per keyed type. 2: `whole_test` on the
  route, the dialog's **Whole test** box (fixed on for a test with no essay
  or short answer), the button on any test with a question, `no_answers` /
  `no_items`. 3: `lib/googleDocs/pictures.ts`. **Deviation:** a 4.5 MB
  picture budget instead of a resumable upload, to keep one Drive upload
  path; past it a picture is a line of text. Only png, jpeg and gif are
  embedded. A stimulus graph (`config.graph`) is not drawn and not
  mentioned. 4: help (`#results`) and rows 921–931, all NOT RUN — row 925
  is the first real check that Drive keeps `data:` images. The roadmap's
  U-25 row lives on the slices 1–3 branch and is updated when they meet.
- 2026-11-02 — **rows 921–931 PASS** locally against real Drive (a
  throwaway `_gdlive` fixture DB, the demo-student accounts, Chrome).
  Drive's HTML import keeps `data:` images (row 925). Observations WT-O1
  (heading at a page foot), WT-O2 (picture on the ☐ line) and finding WT-F1
  (per-student page prints a picture choice as raw markdown, pre-existing)
  are in `docs/design-tool-manual-checks.md`.

