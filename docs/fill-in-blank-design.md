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

**Slice 4 BUILT 2026-10-07 (not deployed).** PDF import (D-3) and Generate
questions (D-9). Design-tool only; no schema change, no migration, no client
change.

- **One normalizer** (`lib/ai/fillBlankNormalize.ts`, pure, shared by both
  paths). The model is asked for blank ids `b1…`, a dropdown's options as
  TEXT strings and its key as the option's text (`correct_option`), a typed
  blank's accepted answers as `keys` — like match pairs and table labels, the
  server assigns ids. It numbers options `o1…` (duplicates by text dropped,
  ≤ 12), finds the key by text (case-insensitive) or by the model's own option
  id, and drops a key that names no option rather than guess; `keys` / `key` /
  `answer` / `correct_answer` become a trimmed, de-duplicated list (≤ 10); a
  stem with `____` lines and no markers gets `[[id]]` per line when the counts
  match; blanks are put in stem order; `correct_answer` is removed (the lone
  typed blank's key when there is one blank). `normalizeProposalMath` now also
  rewrites a dropdown's option text (BG-E1); keys stay plain.
- **PDF prompt** (`PDF_EXTRACT_SYSTEM_PROMPT`): the `fill_blank` shape after
  the table shape, and one rule after the table rule — blank lines inside a
  sentence → the sentence with `[[b1]]…` markers, a word bank → dropdown
  blanks with the whole bank as options and `correct_option` = the keyed
  entry, otherwise typed blanks with `keys`; no key → omit; "A word bank for
  blanks in sentences is fill_blank, not match." 5e1697e's "changes" rule,
  the no-"e.g." sentence and the prose-before-fence parse are untouched (a
  test asserts the first two are still in the prompt).
- **Backstop** (`fillBlankFromUnderscoreStem`, E3's pattern): a short-text
  candidate becomes `fill_blank` with typed blanks when EVERY run of 3+
  underscores in its stem sits inside a sentence — on its own line, a letter
  before it (a leading `2.` / `(b)` number does not count), the text before it
  not ending in `:` or `=`, and something after it. `2. ____ 25000 m`,
  `Answer: ____`, `x = ____` and a trailing line stay short text. The printed
  answer becomes the key only when there is exactly one blank.
- **Panel:** "Fill in the blank · n blanks"; the stem shows each marker as
  `____` (`stemWithGaps`, display only); Add posts the candidate whole, so
  `blanks` rides it. "Needs answer key" shows when no blank is keyed — a
  panel-local check, because a keyless fill-in-the-blank is valid and
  hand-scored (E3-F1) and slice 2's `needsAnswerKey` stays false for it.
- **Mock:** `FB: <stem> | b1:<opt>,*<correct> | b2=<key>;<key>`.
- **Generate questions:** `fill_blank` joins `BATCH_GENERABLE_ITEM_TYPES` and
  the strict type-count map by count only, never under Mix (match's terms).
  `FILL_BLANK_PROMPT_BLOCK` rides the user turn only when requested: the
  sentence is the stem, 1–3 blanks, dropdown preferred with 3–4 options,
  typed when the answer should be produced, every blank keyed, no marker in
  `$…$`, no option ids. Validation drops an element with an unkeyed blank
  (a generated item always has its keys, D-9) or with a marker inside `$…$`
  (`markersInsideMath` — one of the first eight Bedrock elements did it).
  The card shows the sentence with numbered gaps `____ (n)`, each dropdown's
  options without a mark, and "Blank n: …" lines under Show the key; the
  "Check the key" badge applies. The output guardrail already screened option
  text (slice 1).
- **Bedrock evidence (Sonnet 4.6).** A hand-made worksheet (our wording: a
  two-blank sentence with a four-word bank, a one-blank sentence ending in the
  line, a one-blank mid-sentence line with no bank, two `____ 25000 m`-style
  count lines, a key) — 3 runs on the final prompt, 15 / 15 valid each time:
  the bank sentence came back `fill_blank` with two dropdowns, all four words
  on each, both keys right; the two no-bank sentences were `fill_blank` with
  typed keys (the model returned them as short text with the line in the stem
  on 2 of 3 runs and the backstop converted them); both count lines stayed
  short text with key 2. Regression on two teacher samples: Combined Gas Law
  8 valid / 0 rejected as this morning (5 runs: 8 three times, 12 twice — the
  old prompt also gives 12 once in 4: the E4 "Final answer" twins vary); Unit
  0 12 valid / 0 rejected on 6 of 6 runs, no `fill_blank` proposed (its
  underscore runs are name lines and MC answer slots). A first version of the
  rule also told the model that a stand-alone answer line stays short text;
  with it Unit 0 dropped one of its "circle a value" rewrites in 3 of 7
  runs (11 valid; the old prompt 7 of 7 at 12), so the sentence was removed —
  the count lines stayed short text without it. Generate questions, two
  batches twice: 4 fill-in-the-blank from a hand-written water-cycle passage
  (4 / 4 kept both times, 7 blanks each, dropdown and typed mixed, every
  key right) and 2 fill-in-the-blank + 2 short text on a ratio standard (4 / 4
  both times); in the first run one ratio sentence put `[[b2]]` inside
  `$(…)$` and printed the answer beside it — the drop rule above; option math
  (`$(0, 0)$`, `${5.50}$`) came back rendered-ready.
- **Readings, not changed:** the importer rewrites a `____ 25000 m` count line
  into "How many significant figures does … have?" without a `changes` entry
  (the 5e1697e rule's own behaviour); a sentence's closing full stop was
  dropped on one run; the model writes typed keys as the bare word, so a
  teacher widens spellings in the editor.

Tests: design-tool 3040 (full suite), typecheck clean. Rows 515–522 in
`docs/design-tool-manual-checks.md`, NOT RUN.

**Slice 6 BUILT 2026-10-07 (not deployed): the delivery version gate
(D-4).** `lib/items/clientSupport.ts` holds `MIN_CLIENT_VERSION_FOR_TYPE`
(`fill_blank: "1.6.0"`) and `requiredClientUpgrade(version, types)`; a
missing or unreadable `X-SecureTest-Version` counts as too old. The
delivery route (the only route that builds a student bundle) checks the
built bundle's item types and answers 409 `{error:
"client_update_required", min_version}` before the client calls begin(),
so nothing locks. A test without new types still reaches every client,
headerless ones included. `buildDeliveryBundle` now returns a typed
`DeliveryBundle`. The editor says "Students need Secure Test 1.6 or later
for this question type…". Client: `JoinErrorCopy` maps the code to "This
test needs a newer version of Secure Test. Open Self Service, update
Secure Test, then join again." (rides v1.6.0; older clients show their
generic "Could not join. Tell your teacher."). Rows 523–525 NOT RUN.
**With slice 6 in, slices 1–4 can deploy before the client release:**
teachers can author the type, and students on today's clients are
refused cleanly until v1.6.0 reaches them.

**Slice 5 BUILT 2026-10-07 (not released): the client, v1.6.0.** Client only
plus the fixture generator; no schema change, no migration.

- **Core.** `DeliveryItem.fillBlank(FillBlankItem)` with `FillBlankBlank`
  (`.dropdown(id, options)` / `.text(id)`) — an unknown blank kind fails the
  decode, like an unknown item type; nothing can hold `correct_option_id` or
  `keys`. `ItemResponse.fillBlank(answers: [String: String])`.
- **Render** (`fillBlankField` in `AssessmentPage.swift`). `itemBlock` hands a
  `fill_blank` stem to it instead of rendering the stem itself: the stem is
  split at `[[id]]` (the schema's regex, copied), each text segment goes
  through `textWithAssets` (emphasis, pictures; the closing math pass skips
  `select` / `input`), each marker becomes its control, numbered in stem
  order. Unknown and repeated markers stay literal (the preview's rule); a
  blank no marker places renders after the sentence as "Blank n:", numbered
  last (slice 3 scores it). Dropdown = native `<select>` ("Choose…", then the
  options in the teacher's order, D-6, option text through `stripEmphasis`);
  **option math shows as its source** (an `<option>` holds text only — the
  match item's limit, v1). Typed = inline `<input type=text class=fill-text>`,
  autocomplete off, `maxLength` 500 (the write boundary's limit), spell check
  on the per-student gate, width follows the text (8–30 ch). **No math keypad
  and no speech-to-text** on a typed blank (the table has neither either) —
  follow-ups. `aria-label` "Blank n".
- **Posting.** The whole map of answered blanks — a select on `change`, a
  typed blank on `change` and through `textAutosave` (5 s idle / 30 s
  ceiling, flushed on blur / page turn / Finish). A dropdown counts when an
  option is picked, a typed blank when its text is not blank after trim
  (whitespace-only is treated as empty, a small departure from the table,
  which posts it). No answered blank → nothing posted; if something was
  saved (this session or restored), the item is withdrawn through the
  existing DELETE path.
- **Answered mark: every blank** (the match rule); a restored partial answer
  starts unmarked even when `answered_item_ids` names it.
- **Keyboard.** Controls are in sentence order in the DOM; `reachByKeyboard`
  gives each select `tabindex="0"`, text fields are native stops; the one
  `select:focus-visible` ring applies, text fields keep WebKit's own.
- **Read-aloud.** The question's Speak reads each blank as "blank n" (a
  `__ttsBlank` expando `ttsSegments` honours — never the pick, the James
  2026-10-01 rule for content read-aloud), then "Blank n options: …" for each
  dropdown, as a match's options are read. "Read my answer" is ONE control
  for the item (the table's pattern): "Blank n: <option text | typed text>."
  for answered blanks, the mirror highlight on a typed blank, "No answer
  yet." otherwise; typing in a blank stops it.
- **Resume (P-1).** `saved_responses` restores each select (only to an
  option that exists) and each field silently; the restored text is the
  autosave baseline.
- **Styling.** `.fill-select` / `.fill-text` take `font: inherit` and the
  `--line-strong` token like the match select and short text, so contrast
  sets, zoom and fonts reach them.
- **Instant feedback:** unchanged — slice 3's "Blank n: …" lines.
- **Fixture.** `generate-delivery-fixture.ts` seeds position 10: a keyed
  sentence with `**cools**`, a dropdown (windward / leeward / `_northern_`,
  keyed) and a typed blank (keys "rain shadow", "leeward"). Regenerated
  through `buildDeliveryBundle`: 10 items, neither key in the bytes; every
  item id churned as usual, and the match / order entries re-sorted by their
  new ids (tests read labels, not positions). Existing suites updated from 9
  items / 11 pages to 10 / 12.
- **Version.** `MARKETING_VERSION` 1.6.0 (both configurations); 1.5.1 is
  skipped by decision, so its U-15 change rides this release.

Tests: swift 907 (RendererFillBlankTests 14, ItemResponseFillBlankTests 3,
one DeliveryBundleTests case), `xcodebuild` Debug green, design-tool
typecheck clean. Rows "Fill in the blank (v1.6.0)" in
`client/MANUAL-CHECKS.md`, NOT RUN (one needs a real AAC session).

**Non-lockdown hand-run 2026-10-07 (main session, local `_demo`, fixture
`FB + RT hand-run 2026-10-07`).** Design-tool rows 492–517, 519, 525 ✅
(520 / 523 in part); client rows: inline render, pick posts, typed
autosave, teacher side ✅, resume in part — Debug client under simulated
lockdown. Readings, proposals only:
- **FB-R1** the per-student page's type chip prints the raw id
  (`fill_blank`, also `essay` — the page's convention for every type).
- **FB-R3 FIXED 2026-10-07** (James: build before v1.6.0) — an item set to Human is now worth EVERY blank (`fillBlankHandScored` → `fillBlankMaxPoints`), the notes read "no key, score by hand" / "score it by hand", the editor line "Scored by hand: n blanks, one point each". Was: a hand-scored item with only some blanks keyed is worth the
  KEYED blanks (Q3: two blanks, one keyed → "Points (of 1)"), so a teacher
  scoring by hand cannot award the unkeyed blank. A human / hybrid method
  probably wants every blank as the denominator.
- **FB-R4** the editor's live preview line shows the raw `[[b1]]`
  markers (the student preview and print render them).

**Real-lockdown sitting 2026-10-07 evening (local `_demo`, fixture `FB + RT
sitting 2026-10-07`; James at the keyboard).** Pass 1 real AAC (Debug build of
`e110de8` with the AAC entitlement against local dev — localhost survives
finding 10.7), pass 2 simulated with Yellow on Black / 3X / Atkinson. Results
in `client/MANUAL-CHECKS.md` "Fill in the blank (v1.6.0)" and the new "FB-S2 +
FB-S1" table. Findings:
- **FB-S1 FIXED** (`4fa4f41` client, `bf69d8f` teacher) — bold / italic around
  or spanning a blank (`**[[b1]]**`) printed literal `**`: the stem was split
  at the markers before emphasis was parsed, on both sides. Now rendered whole
  with a private-use sentinel per placed blank, the controls swapped in after;
  a marker inside a formula falls back to the old split (well-formed, blank
  kept).
- **FB-S2 FIXED** (James: must ship in v1.6.0; `4fa4f41` client, `79799566d0`
  teacher preview) — options were plain text (native `<option>`), so
  `_italic_` lost its italics and math showed as source (the recorded v1
  limit). The client's dropdown is now a button in the sentence plus an
  in-page role=listbox rendered like the stem; same `value` / `onchange`
  interface, so posting, the mark, resume and read-aloud are unchanged. The
  teacher preview shows a closed "Choose… ▾" box with the options rendered
  after the sentence.
- **FB-S3 reading, accepted** — in full screen macOS takes Escape before the
  page sees it, so Escape does not close the list (Tab / click do). The image
  overlay's Escape is probably in the same position in full screen; unchecked.
- **FB-S4 FIXED** (`4fa4f41`) — the typed blank ignored the contrast set (the
  UA's white box); now `--paper` / `--ink`.

