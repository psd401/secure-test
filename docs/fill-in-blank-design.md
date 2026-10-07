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
  candidate. Generate questions offers it in the same release (D-8).
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
