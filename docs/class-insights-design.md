# Class insights — AI class feedback with a chat (roadmap row CI)

Design note, 2026-10-02. Trigger: open-beta teacher feedback — "class
feedback" with pattern-level information: strengths, areas for growth and
celebrations using specific students as examples, recommended next steps
for whole-class instruction, and a chat to talk with an AI about the
results. Decisions marked **D-n**; James's answers of 2026-10-02 are
recorded as decided, the rest are recommendations. **§Progress says what
is built** (slices 1–2).

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
5. Chat UI (Sonnet 5 / medium).
6. Teacher rows; Bedrock evidence on the `_demo` database.

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
