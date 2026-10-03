# Class insights — AI class feedback with a chat (roadmap row CI)

Design note, 2026-10-02. Trigger: open-beta teacher feedback — "class
feedback" with pattern-level information: strengths, areas for growth and
celebrations using specific students as examples, recommended next steps
for whole-class instruction, and a chat to talk with an AI about the
results. Decisions marked **D-n**; James's answers of 2026-10-02 are
recorded as decided, the rest are recommendations. **§Progress says what
is built** (slices 1–4).

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
  percent, essay criterion levels + the scorer's rationale.
- **D-6 (James, 9.2): students' own words are NOT in the default pack.**
  The report runs on scores, analytics and the scorer's rationale. A chat
  turn that needs the writing (the teacher asks about an item or a
  student's work) pulls ≤ 300 words of the relevant answers for that turn
  only; the turn records which answers it read.
- Scope (**D-7, James, 9.3: one section filter per report in v1**;
  section comparison may come later): the results page's current section
  filter; handed-in attempts
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

**D-8 (James, 9.4): no print page in v1 — "Copy" puts the report on the
clipboard as plain text with names**, preceded by a line "Teacher-only:
names students; not for families." Stored per (assessment, section
filter): the report JSON, the pack's hash,
model id, prompt version. When scores change after generation (new
finals, Change score, pass back) the hash no longer matches and the page
says "Results have changed since this was written — Regenerate".

### The chat (D-4)

Below the report: a conversation grounded in the same pack (and the
report). Every turn: guardrail input + output, `ai_usage`, pseudonyms in /
names out, the same citation rule. Suggested starters ("Why did item 4 go
badly?", "Group students for Thursday's reteach").

- **D-4 (James, 2026-10-02): persist the conversation per assessment.** The
  downsides, and how the design answers each:
  - **It is a record about named students.** Stored with pseudonyms
    only, names swapped in at render — but it is still a student record
    in substance (FERPA / public records). → Retention rule below; the
    teacher can delete a conversation.
  - **It goes stale.** Answers from before a score change keep quoting
    old numbers. → The pack hash is stored per turn; turns from an older
    pack are shown greyed with "based on earlier results".
  - **Who sees it.** **D-5 (James, 9.1): per teacher** — each
    co-teacher has their own thread; the report itself is shared.
    Sharing a conversation is a later feature.
  - **Cost and context growth.** Long threads re-send history. → Cap at
    40 turns per thread; older turns summarized server-side. **Slice 4
    deviation:** no summary — each call re-sends only the last 12 turns, and
    a thread holds at most 40 turns (20 exchanges); at the cap the teacher
    starts a new conversation (409 `thread_full`).
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
   + tests (Opus 5 / medium). BUILT 2026-10-03, no migration, no route,
   no model call — nothing reads it yet: `lib/insights/evidencePack.ts`.
   `buildEvidencePackFromData(input)` is pure (plain items / attempts /
   responses with their FINAL score / open-alert response ids / tag
   lookup in → `{ pack, names }`); `buildEvidencePack(db, { assessmentId,
   section })` loads through `buildResults` (owner scoping, practice out,
   section labels; `section` = null for all, `NO_SECTION_FILTER` =
   `"__none__"` like the results page, else a label), one responses ⟕
   final-score read, the unacknowledged `safeguarding_alerts`, and
   `lookupTags`; analytics go through R1's `buildItemAnalytics` over the
   SCOPED rows (the results page's own footer stays all-sections).
   Defaults: pseudonyms `S1…Sn` by ascending attempt id; items labelled
   `Q<position+1>` like the CSV; stems ≤ 200 chars with pictures read as
   `[image: alt]`; MC choices lettered A, B, … with the key marked; the
   short-text key shown; top 8 short-text answers (trim + case-fold,
   shown as the most common spelling, ties by code point, mean final
   points per cluster); rubric level distributions per criterion ordered
   by points; the scorer's overall rationale ≤ 400 chars; whole-number
   percents, means to 2 places. `pack.figures` is flat:
   `scope.{handed_in,scored,unscored_responses}`,
   `item.Q<n>.{mean,p_value,answered_count,answered_percent,max_points}`,
   `item.Q<n>.choice.<letter>.count`,
   `item.Q<n>.criterion.<name>.<level>.count`, `tag.<stored tag>.percent`,
   `student.S<n>.{total,max}`, `student.S<n>.item.Q<n>.points`,
   `student.S<n>.tag.<stored tag>.percent` (a figure with no value —
   nothing scored — is absent, so a claim citing it drops). `pack.hash` =
   sha256 of the key-sorted JSON; input order does not move it. Choices
   made here: the per-student list holds handed-in attempts with at least
   one final score (totals over finals, `unscored` per student); "scored"
   in the header = handed-in attempts with every answer final; for an
   answer with an open alert the scorer's rationale is withheld too (it
   describes that writing) while its levels and points count; no item
   ids in the pack (slice 2/3 map `Q<n>` back by position). The loader
   takes no `viewer` — access is the caller's precondition, as for
   `buildResults`. Tests: `insights-evidence-pack` (10 pure + 1 loader
   against the test DB).
2. Report: provider method, Zod schema, citation/number fill, storage
   (migration: `class_insight_reports`), staleness hash (Opus 5 / medium). BUILT 2026-10-03, **migration 0052** (`class_insight_reports` + the
   guardrail surface CHECK widened to `class-insights`; applied to dev +
   test), no UI. Where things live: `lib/insights/report.ts` (Zod shape,
   `parseReportObject`, `fillReport`, `reportText`),
   `lib/insights/reportPrompt.ts` (system prompt, user text,
   `CLASS_INSIGHTS_PROMPT_VERSION` = 2026-10-03 with a prompt-hash drift
   test like the essay scorer's — the hash also covers a fixture pack, so a
   change to what the pack carries asks for a bump too),
   `lib/insights/reportView.ts` (render + name swap),
   `generateClassInsights` on the item provider (mock / Bedrock on
   `BEDROCK_ITEM_MODEL`, `ai_usage` surface `class-insights`, 4000 tokens /
   Anthropic dev path), and `app/api/assessments/[id]/class-insights`
   (GET at `view`, POST at `edit`). Choices made here:
   - **Shape:** `strengths`, `growth`, `celebrations`, `next_steps`, each a
     list of `{ text, citations: { items, tags, students }, figures }`;
     ≤ 6 claims per section, next steps 2–4, ≤ 400 chars a claim. The
     four-section object (and the 2–4) is validated whole — a reply that
     fails it is a 502; each claim is then checked alone and DROPPED on
     failure (`dropped_claims` on the row). A reply where no claim survives
     is also a 502. The note's `{item:3.p_value}` became the pack's own key
     form, `{item.Q3.p_value}`.
   - **Fill + the digit rule (D-3):** every `{key}` must be in
     `pack.figures` and is replaced by its value (p-values and percents get
     a `%`; means and counts as slice 1 rounded them); an unknown key, a
     stray brace, an unknown `Q<n>` / `S<n>` (text or citations), an
     unknown cited tag or figure drops the claim. Then, with the `{key}`
     references, the labels and the ALLOWED STRINGS removed, the text must
     carry no digit. Allowed strings = every tag as stored and its code,
     every rubric criterion name and level label — only those containing a
     letter (a level labelled "3" would otherwise admit any "3"), matched
     verbatim. A test asserts every number left in a filled report is a
     formatted pack value. Labels mentioned in the text are added to the
     claim's citations rather than dropping it; a tag cited by code is
     stored as the stored tag.
   - **Celebrations** must cite a student AND a figure or an item, else
     drop.
   - **Stored form:** filled text with labels wrapped as `[[S4]]` /
     `[[Q3]]` (so a render never mistakes an `S1` inside a tag code for a
     student, and a model that writes `[[` itself is dropped); the row
     keeps `pseudonyms` (`S<n>` → attempt id) AND `item_ids` (`Q<n>` → item
     id) — slice 1's result gained `items` for this, beside `names`. No
     name in the row; the guardrail snippet also has pseudonyms only.
   - **Render (GET and the POST's reply):** `[[S4]]` → the stored map's
     attempt → the CURRENT results' name (results built with in-progress
     rows, so a passed-back student keeps their name), else "a student no
     longer in these results"; `[[Q3]]` → the stored item id's CURRENT
     position, else the stored label with the link dropped. `stale` =
     current pack hash ≠ stored; `note` = the current pack's unscored line.
     The loader takes an optional prebuilt `results` so GET builds results
     once.
   - **Section keys:** `__all__` (null), `__none__`, else the label;
     `?section=` / the body's `section` absent, empty or `__all__` = all.
     One row per (assessment, section key), unique; a regenerate upserts
     (same id, new `created_at`). Cascades on assessment delete (D-4).
   - **Gate:** POST 409 `nothing_to_report` when the pack has no student
     (no handed-in attempt with a final score). NOT gated on
     `allow_llm_authoring` — it governs AI authoring of items, and the
     results-side AI (essay scoring, rescore-ai) has never consulted it.
     Access through `authorizeAssessment` (404 below the level, student 403
     by `requireStaff`); `created_by_sub` = the session's sub.
   - **Guardrail:** surface `class-insights`, OUTPUT check only, on the
     filled claim text — the input is the server-built pack with no free
     text typed for this call (the scorer's rationale and the anonymous
     short-answer clusters already passed their own surfaces; alert-flagged
     answers are out). Output block → 422 `guardrail_blocked`, nothing
     stored.
   - **Mock:** deterministic claims from the pack's real keys (best / worst
     item, top tag, most-chosen wrong choice, two lowest scorers, top
     student); title hooks `MOCK_MALFORMED` (502), `MOCK_INVENTED` (three
     claims that must drop), `BLOCKME` (output block).
   Tests: `insights-report` (13 pure: fill, digit rule, celebrations, shape,
   parse, prompt input carries no name / id / hash, render, drift) and
   `insights-report-route` (13 on the test DB: generate + upsert, 409,
   section reports, 400, 502, dropped count, guardrail block + allow, GET
   404 / stale / deleted attempt / deleted item, cascade, student 403,
   foreign 404, view-grantee reads but cannot generate, edit can). Not
   built: the UI, the rating, Copy (slice 3); no Bedrock run yet (slice 6).
3. Report UI on the results page + rating + Copy (Sonnet 5 / medium). BUILT
   2026-10-03, no migration. `components/app/ClassInsightsPanel.tsx` (client;
   GETs the stored report for the page's `?section=` on mount, `view` reads,
   `edit` — `levelSatisfies(level, "edit")` — sees Write / Regenerate), pure
   helpers in `lib/insights/panelCopy.ts` (headings, error copy, Copy text,
   rating message; test `insights-panel`). Choices: the panel shows only when
   the results page has rows; the page's "all sections" (`""`) is sent as
   `__all__`; Q citations link to `#col-q<n>` — a stable `id` added on the
   matrix column header; student citations link to the per-student page, a
   gone student or deleted item renders as plain text; **Copy** = the
   teacher-only line + headings + `- ` claims with names (empty sections
   omitted), "Copied" / failure line; **rating** rides `POST /api/feedback`
   with the message `class-insights rating: helpful|not helpful | assessment
   <id> | prompt <version>` (+ the comment on the next line) — the route
   emails the maintainer for every feedback row, so it gained an optional
   `quiet: true` that stores the row and skips the SNS publish; the panel
   sets it when there is no comment (a rated comment still emails). The
   buttons are replaced by "Thanks for the rating." after sending.
4. Chat: migration (`class_insight_threads`, `…_turns`), route, guardrail,
   per-teacher scope, on-demand answer pull (D-6), cap + summary (Opus 5 / medium).
   BUILT 2026-10-03, **migration 0053** (`class_insight_threads` +
   `class_insight_turns`; applied to dev, test and `_demo`), no UI. Where
   things live: `lib/insights/chat.ts` (pure: thread numbering, names out,
   mentions, the answer pull, the report in thread labels, the provider's
   input type), `lib/insights/chatPrompt.ts` (system prompt, user text,
   `CLASS_INSIGHTS_CHAT_PROMPT_VERSION` = 2026-10-03 with a drift test over a
   fixture input, like the report's), `classInsightsChat` on the item
   provider (mock / Bedrock `converseTextWithMeta` on `BEDROCK_ITEM_MODEL`,
   `ai_usage` surface `class-insights`, 1500 tokens / Anthropic dev path),
   `app/api/assessments/[id]/class-insights/chat` (GET / POST / DELETE), and
   `fillSingleClaim` exported from `report.ts` (the report's own fill with a
   text-limit parameter; `renderClaim` likewise extracted from `renderReport`
   in `reportView.ts`). Choices made here:
   - **Scope / access:** one thread per (assessment, teacher `sub`, section
     key) — D-5; section keys exactly as the report's. All three methods at
     `edit` through `authorizeAssessment` (404 below it), student 403 by
     `requireStaff`. A view-level co-teacher cannot read a chat either. The
     thread's teacher column is `owner_sub` as specified — the
     access-enforcement test's `OWNER_SUB_ALLOWED` gained the route with that
     reason (the thread's own column, scoped to the caller after the
     helper); it is not an assessment-ownership check.
   - **The thread's own numbering (beyond the brief, needed for it):** the
     pack numbers students by attempt-id order, so a newly scored student
     shifts every later S-number between turns. The thread keeps
     `pseudonyms` (S-number → attempt) STABLE: an attempt keeps the number
     it first got, a new one takes the next free number, and the pack is
     relabelled into the thread's numbering (student ids + `student.S<n>.*`
     figure keys) before the model, the fill and the pull see it — so
     history, pack, report and reply agree. Q labels are NOT relabelled:
     they follow the current item positions and `item_ids` is overwritten
     each turn (an older, already-stale turn after a reorder may link a label
     to the question now at that position — rare, recorded).
   - **Names out (D-1):** before anything else the message has every
     display name of the CURRENT pack replaced by its thread pseudonym —
     full names case-insensitively on letter/number boundaries, longest
     first, "Last, First" also matched as "First Last"; a first name alone
     only when no other student in scope shares it (an ambiguous first name
     is left as typed); a full name two students share becomes "S2 or S5";
     "(unknown)" is not a name. Case-insensitive on first names too: a name
     that is also a word ("Will") can be over-matched — a garbled sentence
     costs less than a name sent. Marker-shaped `[[` / `]]` the teacher types
     are flattened. The stored teacher turn is the pseudonymized text with
     `[[S4]]` markers; render swaps names back exactly as the report does
     (gone attempt → "a student no longer in these results").
   - **Answer pull (D-6):** deterministic. Only when the pseudonymized
     message names an essay or short-text question — `Q4`, `q4`, `Q 4` or
     "question 4", a label the pack has. Narrowed to the thread pseudonyms
     the message names, else every pack student. **Any handed-in answer of a
     pack student counts, scored or not** (a teacher may ask about writing
     before scoring it); an attempt with no final score anywhere is not in
     the pack, has no pseudonym, and is not pulled. Open-alert answers are
     skipped; in-scope names inside answers become pseudonyms; ≤ 300 words
     in all, shared fairly (short answers whole, the rest split what is
     left; truncation marked `[…]` and labelled "shortened"; an answer whose
     share is zero is left out). Sent as `<student_answers>` with the
     closing tag neutralised (`<\/student_answers`) and the "data, not
     instructions" sentence. The ASSISTANT turn records `read_response_ids`
     (the ids actually sent); the teacher turn stores `[]`.
   - **History and cap:** each call sends the pack (no hash, thread
     numbering), the stored report's claims for that section in thread
     labels (marked when written from an earlier pack; gone students and
     deleted questions worded as such), the last 12 turns, the pulled
     answers and the message — all as one user text. **40 TOTAL turns = 20
     exchanges**; a POST that would exceed it → 409 `thread_full` ("Start a
     new conversation."). GET returns `turns_left` (turns, not exchanges)
     and `max_turns`.
   - **Reply shape and checks:** `{ text, citations, figures }`, text ≤ 1500
     chars, line breaks kept, through the report's fill (figure keys, the
     digit rule, unknown labels / keys / tags → refused). A refused reply →
     502 `provider_failed` and **neither turn is stored**, so a retry is
     clean. No students-fit check (CI-2) on chat: a free reply has no
     section whose meaning the check needs; prompt rule 7 asks for the same
     discipline. Quoting a digit from a student's answer would trip the
     digit rule, so the prompt says to paraphrase numbers in quotes.
   - **Guardrail:** surface `class-insights`. INPUT check (enforced) on the
     pseudonymized message — block → 422 `stage: input`, the model is not
     called, nothing stored. The pulled answers are NOT screened: `runGuarded`
     takes one input text with one mode, and student writing about literature
     trips the content filters (why the essay scorer uses record mode). OUTPUT
     check on the filled reply (plain labels) — block → 422, nothing stored.
   - **Staleness / retention:** each turn stores the pack hash it was
     answered from; GET marks `stale_turn` when it differs from the current
     pack. Cascades with the assessment; `DELETE ?section=` removes the
     caller's own thread only (`{ deleted: bool }`). A concurrent POST that
     loses the position race → 409 `conflict` (unique `(thread_id, position)`).
   - **Gate:** POST 409 `nothing_to_report` when the pack has no student;
     GET returns an empty thread when none exists.
   - **Mock:** a reply from the pack's real keys (the first Q / S the message
     names, the pulled answers' students); message hooks `MOCK_MALFORMED`
     (502), `MOCK_INVENTED` (a digit → refused, 502), `MOCK_BLOCK_REPLY`
     (output block).
   Tests: `insights-chat` (14 pure: names out incl. ambiguous / duplicate /
   comma forms, thread numbering + relabel, mentions, pull rules + fair word
   cap + tag neutralising, report in thread labels, fill / refusal, prompt
   drift) and `insights-chat-route` (14 on the test DB: store + render with no
   name in any row, no name in the provider's input across message / answers
   / history, pull rules incl. alert and narrowing with read ids, 502s store
   nothing, 400 / 409, cap, input + output guardrail, empty GET, stale_turn +
   gone student, stable numbering when a new student appears, DELETE +
   cascade, access matrix, per-co-teacher threads). Not built: the UI
   (slice 5); no Bedrock run (slice 6).
5. Chat UI (Sonnet 5 / medium).
6. Teacher rows; Bedrock evidence on the `_demo` database. DONE 2026-10-03:
   rows 391–414 run (results in `docs/design-tool-manual-checks.md`), the
   evidence is under §Progress ("Slice 6 evidence"); open items listed there.

Design tool only; no client change. Most useful after row BG slice 1
(tags) and with real scored data — build last of the three beta requests.

## Open questions

- **Acknowledged alerts (James, 2026-10-03): the pack excludes an answer's
  text and rationale only while its safeguarding alert is OPEN** (`acknowledged_at`
  null). Once acknowledged, the answer is treated like any other.

Decided 2026-10-02 (James): 9.1 → D-5 (thread per teacher); 9.2 → D-6
(words only on demand); 9.3 → D-7 (one section, comparison maybe later);
9.4 → D-8 (copy to clipboard only). D-4 persist the chat — confirmed.

- None open. Retention (kept while the assessment exists, teacher can
  delete a thread) stands as written unless the district's records
  guidance says otherwise.

## Progress

- Slice 1 BUILT 2026-10-03 (see §Slices) — not deployed.
- Slice 2 BUILT 2026-10-03 (see §Slices) — routes + migration 0052, no UI,
  not deployed.
- Slice 3 BUILT 2026-10-03 (see §Slices) — results-page panel, Copy, rating;
  teacher rows 391+ in `docs/design-tool-manual-checks.md` NOT RUN.
- Slice 4 BUILT 2026-10-03 (see §Slices) — chat routes + migration 0053, no
  UI, not deployed.
- Slice 5 BUILT 2026-10-03 — chat UI under the report.
- **Deployed 2026-10-03:** slices 1–3 on rev 77 (migration 0052), the CI-1…CI-4
  fixes on rev 78, slices 4–5 on rev 79 (migration 0053). Row CI is LIVE.
- **Slice 6 DONE 2026-10-03** — see "Slice 6 evidence" below.

Slice 5 BUILT 2026-10-03, no migration. `components/app/ClassInsightsChat.tsx`
(client) renders inside `ClassInsightsPanel` after the report states, keyed by
section so each filter loads its own thread. Choices: **shown whenever the
viewer is at edit** (`canGenerate`) and the page has rows — the panel already
renders only with rows, and the chat works with no report; view-level viewers
never see it (the routes need `edit`). Citations reuse the report's renderer,
extracted to `components/app/ClaimCitations.tsx` (the panel imports it). Pure
copy lives in `lib/insights/panelCopy.ts` (`chatErrorCopy` per code + 422
stage, `counterText` from 900 chars, `readAnswersText`, `turnsLeftText` at ≤ 10,
starters, intro; tests in `insights-panel`). The turn list is `role="log"`
`aria-live="polite"`; teacher turns indented on a muted ground, assistant turns
bordered; stale turns grey with "Based on earlier results". Enter sends,
Shift+Enter newline, the typed message survives every error, starters only
fill the box and show while the thread is empty. "Start a new conversation"
asks for confirmation inline, then DELETEs. **One server change:** GET / POST
turns gained `read_answers` (the stored `read_response_ids` length) so the
UI can say "Read N answers" — the shape did not expose it; the route test
asserts it. Intro line says names are swapped for S1, S2… and that up to 300
words of answers may be read when an essay / short-answer question is named.
Rows 405–414. Not done: Bedrock run (slice 6), no DOM-harness click tests.

### Slice 6 evidence (2026-10-03, local dev on the `_demo` database, Bedrock)

Why `_demo`: the origin's hand-run fixtures show no rows once the demo
students' one-day roster rows expire (results are scoped to the owner's
current roster), and real students' work must not be used for a hand-run.
Class: `Cell Structure Check-in` — 7 questions (MC, multi-select, short text,
two-criterion essay, match, order), 4 handed-in fictional students, one essay
unscored at the start. Model: Sonnet 4.6 (`BEDROCK_ITEM_MODEL`).

| Run | Prompt | Time | Tokens in / out | Claims dropped | Checked against the matrix |
|---|---|---|---|---|---|
| Report 1 | 2026-10-03 | 24 s | 4,086 / 1,778 | — | **CI-1 … CI-4** (below) |
| Report 2, 3 | 2026-10-03.2 | 19 s, 21 s | — | 2, 1 | every named student fits; no `%%`; note not repeated; no answer beside a name |
| Regenerate after scoring | 2026-10-03.2 | ≈ 20 s | — | — | stale line cleared |
| Chat 1 ("hardest question") | chat 2026-10-03 | ≈ 20 s | — | — | numbers match; a reasoning slip (Q4 called hardest while Q2 was 0%) |
| Chat 2 (typed name + essay) | chat 2026-10-03 | ≈ 20 s | — | — | 2 of 6 on Q5 and 2 of 12 overall match; read 1 answer; name stored as `[[S1]]` |

- **Findings fixed the same day (rev 78):** CI-1 `75%%`; **CI-2 a growth
  claim named a student among those who got Q4 wrong although that student
  earned full points** — now `studentsFitClaim` drops such claims server-side;
  CI-3 the unscored note repeated inside a claim; CI-4 an anonymous short
  answer paired with a named student. Prompt version 2026-10-03.2.
- **Success measures (§Success looks like):** "every number a pack value" —
  enforced by the fill and its test, and no hand-checked number was wrong;
  "no student identity in any prompt or `ai_usage` line" — tested (report and
  chat), and the stored chat turn held `[[S1]]` where the teacher typed a
  name; "celebrations name real students for real evidence" — enforced since
  CI-2, all four celebrations in reports 2–3 checked true; "mostly helpful"
  ratings — waits on the beta (ratings are stored quietly in `feedback`).
- **Readings, no change:** the chat can still make a reasoning slip without an
  invented number (Q4 "hardest" while Q2 was 0%) — the report's CI-2 check
  does not apply to free chat replies (slice 4 decision); one demo student's
  teacher-changed score disagrees with their chosen option, and the model
  went by the choice counts, which is correct for the pack.
- **Open (not run by hand):** co-teacher rows 401 (view level sees the
  report, no Write) and 411 (per-teacher threads) need a real co-teacher
  grant; the 40-turn cap (409), a live Bedrock guardrail block (404 / 408)
  and the comment-email rating (400) are covered by route / API tests only;
  the chat starters were not all sent on Bedrock.

