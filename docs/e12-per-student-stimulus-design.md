# E12 — a student's earlier answer as the stimulus of a later question

Design page, 2026-09-02. Decisions marked **D-n** are James's; nothing here
is built. Source: `docs/pdf-import-enhancements.md` E12 (the Self-Driving
Car Ethics unit: students write an outline in one assessment, then an essay
in another that should open with *their own* outline).

## What exists that this stands on

- **Stimulus sets (E5).** `item_sets` rows (`stimulus_text`, `layout`) group
  contiguous questions; the delivery bundle carries `item_sets[] {id,
  stimulus, layout, item_ids}` (`lib/api/itemSetsBundle.ts`) and the client
  renders the text above the group (`AssessmentPage.swift` `stimulusBlock`),
  with KaTeX and E6 emphasis. The editor's stimulus card edits the text.
- **Delivery is already per student.** `GET /api/assessments/:id/delivery`
  authenticates the student, resolves their row in the owner's `students`
  overlay (`resolveStudentForOwner`), and requires their existing attempt.
  The bundle is built at that moment, so a per-student stimulus is a
  resolution step inside that route, not a new storage shape.
- **One attempt per (assessment, student).** `attempts` is looked up by that
  pair everywhere (delivery `limit(1)`, finding 8.2's rebind on rejoin); a
  student's outline is therefore one row, and "which attempt" has one answer.
- **Responses.** `responses (attempt_id, item_id, response jsonb)`; an essay
  or short-text answer is `{ type, text }` (`packages/schema` responses).
- **Students are owner-scoped.** `students (owner_sub, roster_ps_id, …)`;
  the same real student has one row per teacher. Two assessments by the
  same teacher share the row; a shared copy (slice C, copy semantics) lives
  under another owner and does not.

## Proposed shape

**Schema (migration 0026).** Two nullable columns on `item_sets`:
`source_item_id uuid references items(id) on delete set null` and
`source_fallback_text text not null default ''`. No new table: the pair
(set, source item) is the whole link, and the per-student text is never
stored — it is read from the source response at delivery time, so a student
who revises their outline before the essay opens sees the revision.

**API.** `PATCH /api/assessments/:id/item-sets/:setId` accepts
`source_item_id | null` and `source_fallback_text`. Validation: the source
item exists, is `essay` or `short_text`, belongs to an assessment with the
**same owner** (D-3), and is not in this assessment. Export carries
`source: { assessment_id, item_id }` beside the stimulus; import (and the
slice-C copy) drops it with a warning when the target owner does not own
that assessment — the link is not portable in v1, by construction.

**Editor.** The stimulus card gains a second block under the text: *Start
with each student's own answer* — pick one of the owner's assessments, then
one of its essay / short-text questions; the card then reads "Each student
sees their answer to '<stem>' from '<assessment>'", and a *Fallback* field
("If a student has no answer yet, show:"). The existing `stimulus_text`
stays as the teacher's lead-in above the quoted answer. Teacher preview and
print show a placeholder block in the answer's place. The readiness
checklist adds "Stimulus for question N pulls from '<assessment>', which
is not published" when the source is still a draft (D-2 decides whether
that is a warning or a block).

**Delivery (the resolution).** In the delivery route, for each set with a
`source_item_id`: find the student's attempt on the source assessment (same
owner → same `students.id`), read `responses` for the source item, take
`response.text`. The set's `stimulus` becomes
`lead-in + "\n\n" + quoted text`, or `lead-in + "\n\n" + fallback` when
there is no attempt, no response, or blank text (D-1 decides whether an
`in_progress` attempt's saved text counts). The quoted text is the
student's own words: it goes through the same renderer as any stimulus
(escaped; `$…$` and `**…**` inside it would render — D-5).

**Client.** Nothing. It renders `stimulus` as today.

**Teacher visibility.** Results / review queue for the essay show, per
student, "Outline: used (N words) / fallback shown" so a teacher reading an
essay knows what the student saw. The monitor is unchanged in v1.

**What the student sees of others.** Only their own text: the resolution
runs under the student's authenticated attempt, and the source attempt is
looked up by their own `students.id`.

## Slices

1. **Schema + API + bundle** — migration 0026, PATCH validation, export /
   import handling, tests. Size M.
2. **Delivery resolution + fallback** — the route step, readiness warning,
   tests with two assessments and one student. Size M.
3. **Editor card + preview placeholder + results indicator.** Size M.
4. **Hand-run**: outline assessment → essay assessment → one student on
   local dev with a minted token, then the origin when a student can sign in.

Cross-owner sources (a colleague's outline feeding my essay) are a v2:
technically a `students` lookup by `(source owner, roster_ps_id)`, but it
is a new data flow between teachers and needs its own decision.

## Decisions (James, 2026-09-02)

- **D-1 any saved text.** An unsubmitted outline still feeds the essay; the
  delivery reads the response row whatever the attempt's status.
- **D-2 warn.** A draft source is a readiness warning, never a block.
- **D-3 same owner in v1.** Cross-owner sources (a colleague's outline
  feeding my essay — a `students` lookup by `(source owner, roster_ps_id)`)
  are **post-MVP**; a new data flow between teachers, decided then.
- **D-4 the student writes the outline inline when missing.** Not a
  teacher-written fallback: when the delivery finds no saved text, the
  bundle marks the set `source_missing: true` and the client renders the
  stimulus block as a writing area ("You haven't written your outline yet —
  write it here first") above the essay. Proposed mechanism, to confirm:
  the inline text is saved as a response on the ESSAY attempt keyed by the
  source item's id (`responses (attempt_id = essay attempt, item_id =
  source item)`), so the next delivery finds it as the source text, the
  essay's own scoring ignores it (it iterates the essay's items), and the
  results indicator reads "Outline: written inline". `source_fallback_text`
  is dropped from the schema. This is the one client change in E12: the
  stimulus block gains an editable state and posts through the existing
  response channel.
- **D-5 accepted.** The quoted answer renders like any stimulus.
- **D-6 accepted.** "Outline: used (N words) / written inline / missing" in
  results and the review queue in v1.

## Slices (revised for D-4)

**Slice 1 DONE 2026-09-02 (local, not deployed):** migration 0026 adds
`item_sets.source_item_id` (FK → items, set null on delete; the type cycle
with `items.item_set_id` broken with `AnyPgColumn`); `PATCH …/item-sets/:id`
takes `source_item_id | null` and checks the question is the owner's, an
essay or short-text, and in another assessment (`checkSourceItem`; foreign
or missing reads as 404, no existence leak); the teacher export carries
`source { assessment_id, item_id }` (`TeacherItemSetSchema` in
`packages/schema`), the delivery bundle gains an optional `source_missing`
(`DeliveryItemSetSchema`, not yet emitted), and import keeps a source only
when this owner owns it and the type is allowed, counting the rest in
`sources_dropped`. Tests: item-sets PATCH cases (essay ok, MC / same
assessment / another owner's / unknown refused, null clears), import keeps
vs drops with the count, schema round-trip; full design-tool suite green.

**Slice 2 DONE 2026-09-02 (local, not deployed):** `lib/api/setSources.ts`
resolves each source-backed set per student inside the delivery route —
the student's saved answer on the source assessment (any attempt status,
D-1), else the outline written inline on this attempt (a response keyed
by the source item, D-4), else `source_missing: true`; the stimulus is the
teacher's lead-in, a blank line, the student's words. `buildDeliveryBundle`
takes the student id; the link never rides the student bundle. The set
loader returns a `source` summary (stem, assessment name and status) for
the editor, and readiness now skips "is empty" on a source-backed set and
warns `pulls from "<name>", which is not published` (D-2). Tests: delivery
with two assessments and one student through all three states; readiness
rules. Full suite green.

**Slice 3 DONE 2026-09-02 (local, not deployed; client not rebuilt yet):**
the delivery set now carries `inline_item_id` (the source question's id —
an identifier only) whenever the answer did not come from the source
assessment, plus `inline_text` when the student wrote it in place before,
or `source_missing` when nothing exists; the stimulus is then the lead-in
alone. The client's stimulus block renders a writing area in that case —
hint "You have not written your outline yet…" or "Your outline. You can
still change it here.", a spell-check-gated textarea prefilled with
`inline_text`, "Saved." on change — and posts `{type: essay, text}` under
`inline_item_id` on the ordinary response channel; the host PUTs it like
any answer. Server side, `loadItemForAttempt` accepts a response for a
question of another assessment only when a set of this attempt's
assessment names it as source and its type is essay / short_text. Swift
`ItemSet` decodes the three fields with absent-safe defaults. Tests:
JavaScriptCore harness (empty area posts under the source id; prefilled
and editable; no area on a resolved or plain set), Swift decode defaults,
delivery states, ingest acceptance. Client rows in `client/MANUAL-CHECKS.md`.

**Slice 4 DONE 2026-09-02 (local, not deployed):** the stimulus card gains
"Start with each student's own earlier answer…" → `SourcePicker` (the
owner's other assessments, then their essay / short-text questions, Use);
with a source set the card reads "Each student sees their own answer to
'<stem>' from <assessment> (still a draft)…" with Remove (PATCH null); the
source is server-managed, so view and snapshot change together and the
card never reads unsaved. Preview and print show a dashed placeholder
"Each student's own answer to '<stem>' (<assessment>) appears here" under
the lead-in. The review queue's entries under a source-backed stimulus
carry `outline { origin, words }` and the card reads "Outline: used (N
words) / written inline (N words) / missing" (D-6). Tests: preview
placeholder, review-queue indicator through missing → inline; full suite
green. Hand-run: design-tool rows 46–47.

1. **Schema + API + bundle** — migration 0026 (`item_sets.source_item_id`
   only), PATCH validation, export / import handling, `source_missing` on
   the delivery bundle, tests. Size M.
2. **Delivery resolution** — the route step (any saved text, D-1), the
   readiness warning (D-2), tests with two assessments and one student. Size M.
3. **Client** — the writable stimulus block when `source_missing`, posting
   the outline on the response channel keyed by the source item; a
   JavaScriptCore harness test. Size S–M; client rows on local dev.
4. **Editor card + preview placeholder + results indicator.** Size M.
5. **Hand-run**: outline assessment → essay assessment → one student on
   local dev with a minted token, then the origin when a student can sign in.

## Unresolved questions

- D-4 mechanism: inline outline saved on the essay attempt keyed by the source item — OK?
- Inline outline later editable from the essay page, or write-once?
