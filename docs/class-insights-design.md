# Class insights — AI class feedback with a chat (roadmap row CI)

Design note, 2026-10-02. Trigger: open-beta teacher feedback — "class
feedback" with pattern-level information: strengths, areas for growth and
celebrations using specific students as examples, recommended next steps
for whole-class instruction, and a chat to talk with an AI about the
results. Decisions marked **D-n**; James's answers of 2026-10-02 are
recorded as decided, the rest are recommendations. **§Progress says what
is built** (nothing yet).

## Relation to the roadmap

- **Builds on reporting R1** (`docs/reporting-design.md`):
  `lib/reporting/analytics.ts` already computes, per item, the p-value,
  % answered and MC distractor counts; the results matrix has the section
  filter. Class insights reads those, it does not recompute them.
- **Reads the standards tags** from `docs/batch-item-generation-design.md`
  (row BG, D-1) — the partial reversal of roadmap D-7. Without tags it
  still works, grouped by item.
- **Uses the AI essay output** from row R (per-criterion rationale on
  final scores) as evidence for writing-based strengths and growth areas.
- **New precedent: student identities and a conversation reach an AI
  surface.** Today the essay scorer sends one essay with no identity; the
  safeguarding screen sends answer text only. D-1 below keeps the model
  on pseudonyms.
- **Never family-facing.** Nothing here appears on the print report, the
  work packet or anything a student or family sees.

## What exists that this stands on

- Results scoping (A5-4): `buildResults` scopes students to the
  assessment owner's roster; co-teachers at `view` and above see results;
  practice attempts and `superseded` / `research` scores are excluded
  everywhere (`test/practice-invisibility.test.ts`).
- `runGuarded` (input + output guardrail), `ai_usage` log line,
  Bedrock Converse via SigV4 (ADRs 0007 / 0011 / 0012).
- Safeguarding alerts (`docs/safeguarding-alerts-design.md`): answers with
  open alerts are known per response.

## Design

### The evidence pack (D-1, D-2)

Server-built, deterministic, the only thing the model sees:

- Assessment: title, item stems (truncated), types, max points, tags.
- Per item: R1 analytics (mean, p-value, % answered, distractor counts
  with the keyed choice), short-text answer clusters (top distinct
  answers with counts), essay criterion-level distributions.
- Per student (pseudonymous `S1…Sn`, D-1): total, per-item points, per-tag
  percent, essay criterion levels + the scorer's rationale, ≤ 300 words of
  each essay / short answer when the teacher asks for writing evidence.
- Scope: the results page's current section filter; handed-in attempts
  with final scores only; a header line "N responses not yet scored —
  scores them first for a complete picture" when any are unscored (D-2:
  generate anyway, say so).
- Excluded: answers with an open safeguarding alert (their text never
  enters the pack; the student's scores do) — a welfare disclosure is
  not material for a class report.

- **D-1 (James): named examples are fine for the teacher.** The model
  sees only `S1…Sn`; the server swaps names back in when rendering.
  Names, emails and student numbers never enter a prompt or a stored row.

### The report

"Class insights" on the results page (owner + co-teachers at `edit`).
Four sections, each a list of claims:

- **Strengths** — items / tags / criteria the class did well on.
- **Areas for growth** — the weakest items / tags, the common wrong
  answer and what it suggests (misconception), with 1–3 example students.
- **Celebrations** — named students: top performers AND growth signals
  that are visible in one test (a strong essay criterion from a student
  low elsewhere; a hard item only a few got).
- **Next steps for whole-class instruction** — 2–4 concrete moves
  (reteach X with Y, a small group for S4 / S9 / S12 on Z), each tied to
  a growth area.

**D-3 every claim carries citations** (item ids, tag, pseudonyms) that
render as links to the item's column / the per-student page. **Numbers
come from the pack, not the model**: the model refers to a figure by key
(`{item:3.p_value}`) and the server fills it; a claim citing a key that
does not exist is dropped. Output is structured JSON validated with Zod.

Stored per (assessment, section filter): the report JSON, the pack's hash,
model id, prompt version. When scores change after generation (new
finals, Change score, pass back) the hash no longer matches and the page
says "Results have changed since this was written — Regenerate".

### The chat (D-4)

Below the report: a conversation grounded in the same pack (and the
report). Every turn: guardrail input + output, `ai_usage`, pseudonyms in /
names out, the same citation rule. Suggested starters ("Why did item 4 go
badly?", "Group students for Thursday's reteach").

- **D-4 (James leaning): persist the conversation per assessment.** The
  downsides, and how the design answers each:
  - **It is a record about named students.** Stored with pseudonyms
    only, names swapped in at render — but it is still a student record
    in substance (FERPA / public records). → Retention rule below; the
    teacher can delete a conversation.
  - **It goes stale.** Answers from before a score change keep quoting
    old numbers. → The pack hash is stored per turn; turns from an older
    pack are shown greyed with "based on earlier results".
  - **Who sees it.** Per teacher, or shared with co-teachers? →
    Recommend **per teacher** (each co-teacher has their own thread);
    sharing a conversation is a later feature.
  - **Cost and context growth.** Long threads re-send history. → Cap at
    40 turns per thread; older turns summarized server-side.
  - **Deleted attempts.** A pseudonym whose attempt was deleted renders
    as "a student no longer in these results".
- Retention (recommendation): kept while the assessment exists; deleted
  with it; not part of the 90-day error-table sweep (D-11).

### Cost and model

One report ≈ one Sonnet-class call on a pack of a few thousand tokens for
a 30-student class; chat turns re-send the pack (cache it with prompt
caching if Bedrock supports it for the model in use). `ai_usage` gives
spend per teacher.

## Success looks like

- A teacher reads the report in a couple of minutes and can name one
  thing they will reteach and to whom.
- Every claim is checkable in one click; no invented numbers (a test
  asserts that every number in a rendered report is a pack value).
- Celebrations name real students for real evidence — never a student
  with no evidence for the claim.
- Teacher rating on each report (helpful / not, optional comment, rides
  the existing feedback table) shows mostly "helpful" across the beta.
- No student identity in any prompt or `ai_usage` line (test).

## Slices

0. This note.
1. Evidence pack builder (pure, from results + analytics) + pseudonym map
   + tests (Opus 5 / medium).
2. Report: provider method, Zod schema, citation/number fill, storage
   (migration: `class_insight_reports`), staleness hash (Opus 5 / medium).
3. Report UI on the results page + rating (Sonnet 5 / medium).
4. Chat: migration (`class_insight_threads`, `…_turns`), route, guardrail,
   per-teacher scope, cap + summary (Opus 5 / medium).
5. Chat UI (Sonnet 5 / medium).
6. Teacher rows; Bedrock evidence on the `_demo` database.

Design tool only; no client change. Most useful after row BG slice 1
(tags) and with real scored data — build last of the three beta requests.

## Open questions

- **9.1** Co-teachers: own thread each (recommended) or one shared?
- **9.2** Include the student's own words in the pack by default, or only
  when the teacher asks a writing question in the chat?
- **9.3** Compare sections ("period 2 vs period 5") in v1?
- **9.4** Export the report (print / copy) — teacher-only print page?

## Progress

Nothing built.
