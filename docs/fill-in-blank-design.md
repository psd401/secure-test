# FB — fill in the blank (dropdown and typed blanks)

Design page, 2026-10-07. Source: open-beta teacher feedback, with a
screenshot of a Schoology "fill in the blank — dropdown" question for
reference: a sentence with numbered blanks, each blank with its own
option list, and the correct choice set per blank. Decisions marked
**D-n** are James's (D-1…D-10, all 2026-10-07). Nothing is built.

## Decided (James, 2026-10-07)

- **D-1 Both kinds of blank.** A blank is either a **dropdown** (the
  student picks one of the blank's options) or **typed** (the student
  types a short answer). One item can mix both.
- **D-2 Score per blank.** One point per blank, like a table's keyed
  cells (E3 D-2). `max_points` = the number of keyed blanks.
- **D-3 The PDF import proposes it.** A worksheet sentence with `____`
  inside it (not a stand-alone answer line) becomes a fill-in-the-blank
  candidate. Generate questions offers it in the same release (D-9).
- **D-4 Older clients: version gate + Self Service message (9.1).** The
  delivery route refuses a bundle carrying `fill_blank` to a client whose
  `X-SecureTest-Version` is older than the release that renders it (and
  to a client that sends no version). Like EX-2, the refusal arrives
  before `begin()`, so nothing locks. The client shows: "This test needs
  a newer version of Secure Test. Open Self Service, update Secure Test,
  then join again." No IT work is needed: Self Service already offers the
  update. A button that opens Self Service could come later if wanted.
  It would need the policy id from IT for a direct link.
- **D-5 Several accepted answers per typed blank (9.2).** A typed
  blank carries `keys: string[]` (1 or more). Any one matching earns the
  point.
- **D-6 Dropdown options in the teacher's order (9.3)** for this
  version. No shuffle.
- **D-7 No alternate answer sets (9.4).** Schoology's "+" (a whole
  second set of correct answers with its own percentage) is skipped.
  Per-blank keys (D-5) cover most of it.
- **D-8 One point per blank only (9.5).** No per-item "all or nothing"
  option.
- **D-9 Generate questions offers it now (9.6)**, in the same release as
  the PDF import (slice 4).
- **D-10 Teacher-facing name: "Fill in the blank" (9.7).**

## What exists that this stands on

- **Item types are a closed union on both sides.** `ItemSchema`
  (`packages/schema/src/items.ts`), `DeliveryItemSchema` (`delivery.ts`)
  and `ItemResponseSchema` (`responses.ts`) are discriminated unions of
  nine types. The client's `DeliveryItem` enum
  (`client/SecureTestCore/Sources/SecureTestCore/DeliveryItem.swift`) is
  exhaustive, and **a bundle carrying a type the installed client does
  not know fails the whole decode**. So a published test with one
  fill-in-the-blank item would refuse to open on every client that is
  older than the release that renders it (see §Release gating).
- **No migration.** `items.type` is text; extras and keys live in the
  `items.config` jsonb, guarded by Zod at the write boundary
  (`design-tool/lib/api/items.ts`). `DEFAULT_SCORING_METHOD` /
  `ALLOWED_SCORING_METHODS` gain an entry.
- **Keys never ride the student bundle** (ADR 0016). The delivery shape
  carries each dropdown's options and nothing that can hold a key.
- **Typed-answer matching exists.** `shortTextMatches` (trim, whitespace,
  case fold, the E7(b) formula rule), numeric equivalence with the
  per-item `exact_form` opt-out (2026-09-15), the math-entry
  `canonicalizeMath`, and `tableCellMatches` (E3) cover a typed blank.
- **Per-part scoring exists.** The table item scores per keyed cell and
  reports `max_points`; the review queue, results matrix, print and work
  packet already show a multi-point auto item.
- **Version-gated delivery exists.** The delivery route reads
  `X-SecureTest-Version` (EX-2, sent by v1.5.0+).

## Proposed shape (for review)

**Item (`items.config`).**

```
type: "fill_blank"
stem: "An impact of the rain shadow effect is that the [[b1]] side …
       while the [[b2]] side …"
blanks: [
  { id: "b1", kind: "dropdown", options: [{id, text}], correct_option_id },
  { id: "b2", kind: "text", keys: ["leeward"], exact_form?: boolean },
]
```

- The stem holds `[[<blank id>]]` markers. Every marker has exactly one
  blank and every blank has exactly one marker (readiness check).
- Dropdown options are **per blank** (the Schoology shape). The editor
  has a "same options as blank 1" shortcut, because the reference
  question repeats one list.
- A blank without a key is allowed while drafting, and is hand-scored
  like a keyless table cell (E3-F1 rule).
- Math (`$…$`) and **bold** / _italic_ render around the blanks as in
  any stem. Option text takes math too.

**Delivery.** `{ type: "fill_blank", stem, blanks: [{ id, kind,
options? }] }`. Options keep the teacher's order (D-6). No key field.

**Response.** `{ type: "fill_blank", answers: { <blank id>: string } }`.
A dropdown answer is the option id; a typed answer is the text. A blank
left empty is absent from the record. An item with no answers posts
nothing (the match rule).

**Scoring.** Dropdown: id equality. Typed: any of `keys` matches through
the short-text rule (numeric equivalence unless `exact_form`). One point
per keyed blank.

## Release gating (the one structural risk)

An older client refuses a bundle that carries an unknown type, so the
whole test fails to open. That is worse than one missing question. Two
options:

- **(a) Gate at delivery.** A bundle containing `fill_blank` goes only to
  a client whose `X-SecureTest-Version` is ≥ the release that renders
  it. Older clients get a clear refusal: "This test needs the latest
  Secure Test — ask your teacher." This keeps working after the fleet
  updates, with no teacher-facing rule.
- **(b) Gate at publish.** Publish refuses a test with a fill-in-the-
  blank item until a date or flag says the fleet is current. This is
  simpler on the wire but asks the teacher to wait.

**Decided: (a), as D-4**, plus a readiness note in the editor
("Students need Secure Test 1.6 or later") until the fleet has the
release.

**Deferred to v2.0 (James, 2026-10-07): a server-delivered renderer.**
The page JS that draws items is bundled in the signed client today
(`AssessmentPage.swift`), so every new item type needs a client release.
If the server delivered that JS instead, new types would ship with a
design-tool deploy, and the native shell (lockdown, sign-in, exits,
spool, uploads) would stay signed. The cost: the server decides what
code runs inside the locked web view, so the JS-to-native bridge must
stay narrow and validated. That is an ADR-level decision. It is to
discuss, not decided. The roadmap's v2.0 list carries it.

## Slices

0. This note + decisions.
1. Schema (both bundles + response) + API write guard + scoring +
   export / import round trip + preview / print rendering.
2. Editor: an "Insert blank" button at the cursor, a per-blank panel
   (kind, options or keys, `exact_form`), "same options as blank n",
   readiness checks (orphan marker, blank without marker, dropdown with
   fewer than 2 options).
3. Teacher read side: review queue, results matrix / per-student page,
   work packet, Google Docs release (essays only today, so this one is
   likely a no-op), instant feedback.
4. PDF import (D-3) and Generate questions (D-9): prompt shapes + a backstop that turns `____` inside a
   sentence into a typed blank when the model returns a short answer with
   the line in its stem.
5. Client: inline `<select>` and inline text field in the sentence
   (`emphasisNodes` around them), keyboard reach (the v1.3.5 tabindex
   rule), read-aloud reads the blank as "blank 1", autosave, resume
   prefill, the answered mark only when every blank has an answer (the
   match rule). This ships in a client release.
6. Delivery gating per §Release gating + rows.

## Open questions

None. All decided 2026-10-07 (D-1…D-10). The v2.0 server-delivered
renderer above is a separate discussion.

## §Progress

**Slice 1 BUILT 2026-10-07 (not deployed).** Schema, write
boundary, scoring, both bundles, export / import, preview / print. No
migration (`items.type` is text; blanks live in `items.config.blanks`).

- **Shape as proposed.** `FillBlankItemSchema` (teacher bundle) carries
  `blanks: [{id, kind: "dropdown", options ≥ 2, correct_option_id?} |
  {id, kind: "text", keys?, exact_form?}]`; `DeliveryFillBlankItemSchema`
  keeps only id, kind and a dropdown's options (teacher's order, D-6);
  `FillBlankResponseSchema` is `answers: blank id → string` (≥ 1 entry,
  ≤ 500 chars). `fillBlankMarkerIds` / `FILL_BLANK_MARKER_RE` in the schema
  package are the one reading of a `[[id]]` marker (ids: letters, digits,
  `_`, `-`, ≤ 40).
- **Write boundary** (`lib/api/items.ts`): ≤ 20 blanks, 2–12 options, ≤ 10
  keys, 500-char option text and keys; every marker names one blank, every
  blank has exactly one marker, a marker appears once, option ids unique,
  `correct_option_id` names an option. Keys stored only when set
  (`compactBlanks`). The publish lock admits per-blank key changes
  (`correct_option_id`, `keys`) and nothing else; `exact_form` stays
  locked after publish, like short text's (review choice, one rule for
  both types). `isKeyedBlank` lives in the schema package beside the
  shape, so the pure scorer does not import the write boundary.
- **Scoring:** one point per keyed blank (D-2 / D-8); a dropdown by option
  id; a typed blank by any key (D-5) through `shortTextMatches` with the
  blank's own `exact_form` (numeric equivalence, formula fold,
  `canonicalizeMath` exactly as short text). No keyed blank → unscorable and
  the unset method default is `human` (the E3-F1 rule); `fillBlankMaxPoints`
  (keyed blanks, else every blank) is the denominator in results, the review
  queue and the manual-score check.
- **Ingest:** an answer naming an unknown blank, or a dropdown answer naming
  an unknown option, is refused `400 unknown_option_id` (`""` = cleared pick,
  accepted).
- **Preview / print:** the stem is split at its markers and each text segment
  rendered by `renderItemContent`; screen = disabled `<select>` (option text
  escaped, so option math shows as source) or an underlined gap; print =
  numbered gaps plus each dropdown's options as a lettered list. A marker
  naming no blank stays literal text. **Limit:** math or emphasis that
  spans a marker is split by it.
- **Minimum read side (slice 3 owns the real one):** instant feedback,
  results / per-student lines and the queue's fallback text list
  "Blank n: …"; Google Docs is essays only (no change).
- **Hidden:** the editor's "Add a question" picker does not offer it
  (`NOT_YET_PICKABLE`) until slice 2.
- **Not done here, on purpose:** import does not re-check marker ↔ blank
  pairing (the wire layer stays permissive, like match / table); no answer
  history for typed blanks; no asset refs in option text; readiness checks
  (slice 2); the Swift fixture and the delivery version gate (slices 5–6).

Tests: schema 135, design-tool 2969 (full suite, after review fixes), typecheck clean.

**Slice 2 BUILT 2026-10-07 (not deployed).** The editor. Design-tool only;
no schema change, no migration.

- **Form** (`app/dashboard/[id]/FillBlankEditor.tsx`; pure logic in
  `lib/items/fillBlankEditor.ts`). The sentence is the card's ordinary stem
  textarea. **Insert blank** sits beside Bold / Italic. It puts `[[bN]]` at
  the caret, or in place of a selection, and the selected text becomes the
  new typed blank's first accepted answer. A space is added next to a word.
  N is one past the highest `b<n>` in use, so a removed id is never handed
  out again (an unpublished test's old responses may name it). Per blank:
  Kind (Dropdown / Typed answer); a dropdown's options (2–12, the teacher's
  order, D-6) with a radio for the optional correct one, "No correct
  option", and **Same options as Blank n** (copies the list; the target
  keeps its own answer only if an option with the same text exists); a
  typed blank's accepted answers (1–10, "any one is accepted", D-5) and
  **Answer form matters** with short text's wording. Switching kind carries
  the answer across (the correct option's text becomes the accepted answer,
  and back); a dropdown's wrong options are not kept.
- **Stem order.** The `blanks` array is kept in the order its markers first
  appear: on load (`rowToView`, `page.tsx`), on every keystroke in the
  sentence, on insert, and in the save payload (`blanksForSave`, which also
  drops blank accepted answers). So "Blank n" in the form is Blank n for
  students and in every report.
- **Deleted markers.** Deleting a `[[b1]]` by hand does NOT delete the blank
  or its key. The blank stays in the list, last, marked "Not in the
  question any more." with **Put it back (at the end)**. **Remove blank**
  removes the blank AND its marker(s). A typed `[[b9]]` with no blank gets
  **Add a blank for it** / **Delete it from the question**. Both states are
  readiness gaps, and a Save in either state is refused by slice 1's
  boundary; the card now shows the boundary's blank messages after "This
  question isn't complete yet" (`fillBlankIssueMessages` reads the 400's
  `detail`).
- **Readiness** (`readiness.ts fillBlankGaps`): "needs at least one blank",
  "has [[b9]] in its text but no blank for it", "uses [[b1]] more than
  once", "blank n is not in the question text", "blank n needs at least 2
  options", "blank n has an empty option". No key is not a gap (the table's
  E3-F1 rule). The Add seed "New sentence with a [[b1]]." joins SEED_TEXT.
- **Scoring label:** the unset method reads Human until a blank has a key,
  then Auto (E3-F1, as the server's `effectiveScoringMethod`).
- **Publish lock:** the sentence, Insert blank, kind, option text, Add /
  Remove option, Same options as, Remove blank and Answer form matters are
  disabled. The correct-option radios, "No correct option" and the
  accepted answers stay editable. `answerKeyOnlyChange` compares blanks
  without `correct_option_id` / `keys`, as the server's
  `isAnswerKeyOnlyPatch` does, so Save lights up for exactly those edits.
- **Picker:** `NOT_YET_PICKABLE` is gone; "Fill in the blank" is offered.
- **Not done:** no rendered sentence preview in the card (the Preview
  button shows it); option text has no inline math preview.

Tests: design-tool 2997 (full suite), typecheck clean. Rows 492–503 in
`docs/design-tool-manual-checks.md`, NOT RUN.

**Slice 3 BUILT 2026-10-07 (not deployed).** The teacher read side.
Design-tool only; no schema change, no migration, no client change.

- **One reading** (`lib/items/fillBlankAnswer.ts`, pure): stem + blanks +
  the response's `answers` → `segments` (raw stem text | a filled blank),
  `unplaced` blanks, every blank in number order, `keyed_count` /
  `right_count`. A filled blank carries its number, kind, the answer as TEXT
  (a dropdown's option text, never its id; an unknown id → no answer +
  `unknown_option`), `keyed`, `right` (the scorer's own rule — option-id
  equality, `fillBlankTextMatches` with the blank's `exact_form`; a test
  proves `right_count` / `keyed_count` equal `scoreResponse`), and `expected`
  (the correct option's text, or every accepted answer, D-5). Numbering and
  marker reading are the preview's: stem order of first appearance; a
  repeated or orphaned marker stays literal text; a blank no marker places is
  kept (it is still scored), numbered last.
- **One renderer** (`lib/reporting/fillBlankView.ts`): the sentence as HTML —
  stem segments and dropdown option text through `renderItemContent`, typed
  answers and keys escaped. Each blank: a small number, the answer (or
  "(blank)"), and with `showKey` a ✓ / ✗, "expected X or Y" on a wrong keyed
  blank, "no key, not scored" on an unkeyed blank of a partly keyed item.
  `summary` adds "Keyed blanks matching the key: n of m." (plus the unkeyed
  count), or "No blank has a key — score each blank by hand (1 point each)."
  for a keyless item. `.fb-*` styles in `app/globals.css`; print ink in the
  packet's own CSS.
- **Review queue:** the route sends `fill_blank_html` (rendered server-side,
  stem_html's reason); the card shows it in place of the answer block and
  drops the clamped stem line (it would show `[[b1]]`). Points max was
  already `fillBlankMaxPoints` (slice 1).
- **Per-student page:** the filled sentence replaces the stem (with keys and
  the summary); an unanswered item shows the sentence with "(blank)" gaps and
  "No answer.". The results matrix cell is unchanged (points / max).
- **Work packet:** with questions, the filled sentence replaces the stem —
  marks, "expected" and the summary only with `scores=teacher|both` (W-1);
  with `questions=0`, answerView's "Blank n: …" lines (✓ / ✗ gated the same
  way). The toolbar's stem excerpt reads a marker as "(blank)".
- **answerView:** a new `fill_blank` kind carrying the lines, from the
  reading (callers pass `stem` so numbering is the stem's).
- **Instant feedback: lines kept**, now numbered through the reading. A
  sentence form was not built: the client escapes `your_answer` and runs only
  the `$…$` pass over it (`InstantFeedbackPage.swift`), so stem emphasis
  would show as raw `**`, and per-blank marks would need a new field. Both
  need a client release; the slice-1 shape stays. `correct_answer` still
  lists every keyed blank (the table's posture), not only the missed ones.
- **Class insights evidence pack:** the stem with `[Blank n]` gaps;
  `blanks` (label, kind, option texts, keys); per-blank `blank_answers`
  (answered / right counts, top answers — a dropdown as option text, typed
  answers clustered case-folded, alert-flagged answers counted but never
  listed); figures `item.Qn.blank.k.answered_count` / `.right_count`. The
  report / chat prompts were NOT changed (the fields are self-describing;
  changing a prompt means a version bump and a recorded hash) — the
  pack hash changes for an assessment with a fill-in-the-blank item.
- **Left, as decided:** answer history (none for blanks), Google Docs
  (essays only). Score change / pass back read `itemMaxPoints` /
  `checkManualScore`, already fill_blank-aware since slice 1.
- **Not done:** a typed answer is shown as escaped text, not KaTeX (short
  text renders math via `renderShortTextAnswer`; whether a typed blank does
  waits on the client's slice 5 input). Option text with an asset ref is
  not resolved (slice 1 limit).

Tests: design-tool 3020 (full suite), typecheck clean. Rows 504–514 in
`docs/design-tool-manual-checks.md`, NOT RUN.
