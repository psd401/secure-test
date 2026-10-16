# Co-teacher gaps — what is still open after the 2026-09-22 follow-ups

Design note, 2026-10-15. The repo ledger listed three co-teacher follow-ups
as "not built" on 2026-09-22 (the owner's Students page shows a co-taught
student as "unlinked"; the results section label and the work-packet
enrolment count use only the owner's sections). A read of today's code for
this note found **all three were built the same evening** in `dfa0e56`
("Co-teacher follow-ups: section filter + work-packet enrolment span the
assessment's sittings; co-taught rows on the Students page";
`docs/access-model-design.md` §Progress records it). The ledger line was
never updated. Reading the same code turned up the gaps below instead.
Nothing is built.

## Decisions (James, 2026-10-15)

- **D-1** (3.1) G-1 fix A: an assessment-scoped image URL, opened at view
  level on the assessment, for the asset ids the assessment references.
- **D-2** (3.2) G-2: a no-section co-teacher sitting is labelled by the
  co-teacher's own sections first.
- **D-3** (3.3) G-3: view keeps printing named student work (the access
  model's levels stand); fix the "owner-only" wording.
- **D-4** (3.4) G-4 and G-5 are built now, with the others.
- **D-5** (3.5) Hand-run: the one-day teacher-row script plus a colleague
  James names later, holding a co-teach grant.
- **D-6** (2.1, 2026-10-16) G-1 keeps the assessment-scoped URL (D-1), not a
  widened `/api/assets/[id]`: the check stays one assessment wide.
- **D-7** (2.2) The owner exception lives in the route: a caller who owns the
  asset (or an admin) loads it through the scoped URL even before the
  assessment references it (the editor's live preview of an unsaved insert).
- **D-8** (2.3) "Referenced" is the preview's set: stems, choices, set
  introductions and sources, item-config images. Rubric text and keys are
  not scanned.
- **D-9** (2.4) G-6 is recorded only.

## Confirmed fixed (for the record)

- **Students page** — unmatched overlay rows go through `splitCoTaught`
  (`design-tool/lib/roster/teacherRoster.ts:155–215`): a student with a
  non-practice attempt through another teacher's class sitting is listed
  under "co-taught · N students", grouped by that sitting's section and
  owner. Test: `test/co-teacher-tenant.test.ts:324`.
- **Results section label + filter** — `resolveSection` reads the attempt's
  own sitting's section first (`lib/scoring/results.ts:397–410`); the
  filter is the union of row labels and every section any sitting on the
  assessment named (`sectionsNamedBySittings`, :194–204).
- **Work-packet "N of M handed in"** — `sectionEnrolment` (:216–237) unions
  the owner's sections with sitting-named ones.

## Still open

### G-1 — co-teachers cannot see the owner's images (real, not yet reported)

`GET /api/assets/[id]` requires level **own** on the asset's owner
(`app/api/assets/[id]/route.ts:23` → `authorizeAsset`,
`lib/api/access.ts:278–294`). Every teacher-facing page emits
`<img src="/api/assets/<id>">`, so a co-teacher (any grant level) or an
admin acting outside an act-as gets a broken image wherever the owner's
picture appears. On top of that, four readers resolve refs under the
**viewer's** `session.sub`, so the `<img>` is not even emitted:

- `app/dashboard/[id]/results/work/page.tsx:539` (work packet)
- `app/dashboard/[id]/results/[attemptId]/page.tsx:424` (per-student page)
- `app/api/assessments/[id]/review-queue/route.ts:82` (scoring queue)
- `app/actions/renderContent.ts:30` (editor live preview / `RenderedText`,
  which has no assessment id to scope by)

The preview (`app/preview/[id]/route.ts:100`) and the student bundle
(`lib/api/bundleAssets.ts:61`) already resolve under the assessment's
owner — so students see the images; only co-teaching staff do not. Inferred
from code; not reproduced (needs a second staff account — rows 224–227
territory).

**Fix options:**
- **A (recommended).** Asset access through the assessment: the four
  readers resolve under `assessment.owner_sub` (the preview's pattern), and
  `<img>` points at an assessment-scoped URL —
  `/api/assessments/[id]/assets/[assetId]` — authorized at **view** on the
  assessment and requiring the asset's `owner_sub` = the assessment's owner
  AND the asset id to be referenced by that assessment's items / sets.
  `renderContent` gains an optional `assessmentId` argument. The owner's
  own `/api/assets/[id]` stays as is (Images page, uploads).
- B. `authorizeAsset` grants view to anyone with any grant from the asset's
  owner. Simpler, but it opens every one of the owner's images, including
  ones in assessments the co-teacher was never shared.

### G-2 — a co-teacher's sitting that names no section loses the section label

When a co-teacher runs a sitting scoped to "all my sections" or a student
list (no `section_ps_id`), `resolveSection`'s fallback (b) looks the
student up only in the **owner's** current sections
(`lib/scoring/results.ts:384–395`). The co-teacher's students then read
"No section" on the results page, are left out of every work packet (the
packet prints by section), and drop out of the section filter. Recorded as
"left as is" in `dfa0e56`'s message.

**Fix:** in fallback (b), try the attempt's sitting owner's sections
(`test_sessions.owner_email` is already loaded in `testSessionRows`, :356)
before the assessment owner's; add the sitting owner's matching sections to
`sitting_sections`. Regression case in `test/co-teacher-tenant.test.ts`.

### G-3 — the work packet says "owner-only" but admits any grant

`/dashboard/[id]/results/work` checks `pageAssessment(…, "view")`
(`page.tsx:339`), so any co-teacher or admin can print it — correct under
the access model, but the page comment (:38, :51–57) and
`docs/student-work-export-design.md` §FERPA still say owner-only. Doc and
comment fix only, unless view should not include student work (see 3.3).

### G-4 — no guard against two open practice sittings for one teacher

`POST /api/test-sessions` skips the duplicate check for practice
(`route.ts:185`); only the UI hides "Practice on my Mac"
(`SittingsPanel.tsx:362`). Two tabs or a double press make two. Harmless
today ("Your tests" collapses to one row, `lib/api/mySittings.ts:214–255`),
recorded 2026-09-22. **Fix:** a partial unique index
`test_sessions(assessment_id, practice_for_sub) WHERE kind = 'practice' AND
status = 'open'` (one migration), and the route answers the existing
sitting on conflict — the U-13 pattern.

### G-5 — section lookups compare teacher emails case-sensitively

`sectionsCurrentlyTaughtBy` / `studentsInTeachersSections`
(`lib/roster/queries.ts:82–105, 153–195`) compare `teacher_email` exactly;
`coTeachersOf` and `teachersCurrentlyTeaching` use `lower(trim())`. Callers
normalize the session email, so only a mixed-case value in the warehouse
extract would miss. **Fix:** `lower()` on both sides, or normalize at
import (`lib/roster/extract.ts`). Worth one read-only Aurora count first
(`teacher_email <> lower(teacher_email)`).

### G-6 — a co-teacher's inserted image belongs to the co-teacher

Found 2026-10-16 while building G-1; recorded only (D-9). The editor's Image
picker lists the CALLER's own images, so an edit-level co-teacher who inserts
a picture references an asset owned by the co-teacher. Every reader resolves
under the assessment's owner, so students, the owner and the preview see
"[image not found]"; only the co-teacher's own editor preview shows it (the
D-7 exception). A fix means the picker lists the owner's images for a
grantee, or uploads made inside an assessment land under its owner — an
access decision of its own.

## Recommendation

One slice each, in order G-1 (the only one a co-teacher would hit on every
assessment with a picture), G-2, then G-3 + G-4 + G-5 together. Design tool
only; G-4 is the only migration. Rows need a second staff account with a
co-teach grant (the same blocker as rows 223–228 / 252).

## Progress

- **G-1 BUILT 2026-10-16, not committed, not deployed.**
  `GET /api/assessments/[id]/assets/[assetId]` → `authorizeAssessmentAsset`
  (`lib/api/access.ts`: `view` on the assessment + owner's asset + referenced,
  else the asset's owner or an admin). `lib/assets/assessmentAssets.ts`
  (`referencedAssetIds`, `resolveAssessmentAssets` under `owner_sub`),
  `lib/assets/assessmentAssetUrl.ts` (pure, for client components),
  `lib/assets/assetResponse.ts` (shared with `/api/assets/[id]`).
  `ResolvedAsset.url` + `assetSrc` carry the URL through `renderItemContent`
  and `renderHtml` without new parameters. Switched: preview, work packet
  (incl. its hotspot `<img>`), per-student page, review queue,
  `renderContent(text, assessmentId?)` via `AssessmentIdProvider` around the
  editor (MathPreview, RenderedText), the editor's drawing-reference and
  hotspot `<img>`s. The Images page and Image picker keep `/api/assets/[id]`.
  Tests: `test/assessment-assets.test.ts`; the access-enforcement allowlist
  lost the preview entry. Hand-run rows not written yet (need the co-teach
  grant, D-5).

## Open questions — answered 2026-10-15 (see Decisions)

- 3.1 G-1: assessment-scoped image URL (A) agreed?
- 3.2 G-2: label a no-section co-teacher sitting by the co-teacher's
  section — agreed?
- 3.3 G-3: should `view` (the lowest grant) be able to print named student
  work, or should the packet need `run`?
- 3.4 G-4 / G-5: build now, or record and wait for a report?
- 3.5 A second staff account for the hand-run — can IT provide one?
