---
type: Reference
title: Teacher dashboard
description: Route map, page guards, teacher header with Help, Roadmap and Send feedback, assessment editor tabs, live sitting monitor, results and scoring entry points, the system-admin console (/admin, district-wide open sittings and safeguarding alerts), and shared components of the staff-facing teacher UI under design-tool/app.
tags: [teacher-ui, dashboard, navigation, design-tool]
openwiki:
  roles: [domain, architecture]
  change_kinds: [ui, access]
  source_paths:
    - design-tool/app/dashboard/layout.tsx
    - design-tool/app/dashboard/page.tsx
    - design-tool/app/dashboard/[id]/page.tsx
    - design-tool/app/dashboard/[id]/AssessmentEditor.tsx
    - design-tool/app/dashboard/[id]/monitor/[sittingId]/page.tsx
    - design-tool/app/dashboard/[id]/monitor/[sittingId]/MonitorView.tsx
    - design-tool/app/dashboard/[id]/results/page.tsx
    - design-tool/app/dashboard/[id]/scoring/page.tsx
    - design-tool/app/dashboard/accommodations/page.tsx
    - design-tool/components/app/AppChrome.tsx
    - design-tool/components/app/AppHeader.tsx
    - design-tool/components/app/FeedbackDialog.tsx
    - design-tool/app/api/feedback/route.ts
    - design-tool/public/help.html
    - design-tool/public/roadmap.html
    - design-tool/app/admin/page.tsx
    - design-tool/app/admin/safeguarding/page.tsx
  symbols: [DashboardPage, AssessmentEditorPage, MonitorPage, showAllTeachersToggle, homeListMode, ownerCell, EDITOR_TABS, parseTab, MonitorView, LIVE_INTERVAL_MS, AppChrome, AppHeader, FeedbackDialog, AdminPage, AdminSafeguardingPage, adminAlertMode]
  test_paths:
    - design-tool/test/admin.test.ts
    - design-tool/test/safeguarding-alerts-ui.test.tsx
    - design-tool/test/all-teachers-ui.test.ts
    - design-tool/test/reporting-views.test.tsx
    - design-tool/test/co-teach-ui.test.tsx
    - design-tool/test/attendance-view.test.ts
    - design-tool/test/access-enforcement.test.ts
    - design-tool/test/feedback-api.test.ts
  invariants:
    - A visitor without a staff session is redirected to login; an assessment or sitting the caller cannot reach renders 404, not a forbidden panel.
    - The All-teachers view is admin-only; a non-admin ?all=1 is ignored.
    - The monitor polls every LIVE_INTERVAL_MS only while the sitting is open or a student is still in progress, and not while the document is hidden.
  validation_commands:
    - cd design-tool && bun test test/all-teachers-ui.test.ts
---

# Teacher dashboard

The teacher dashboard is the staff-facing Next.js UI under `design-tool/app/dashboard/`. Most pages are server components that load data and then hand it to client panels. Every route sits behind the staff session gate described in [auth and access](auth-and-access.md). Panels call existing API routes and hold few rules of their own; the rules live in the `lib/api` and `lib/*` modules that those routes call.

## Route map

| Route | Page source | What it is for |
|---|---|---|
| `/dashboard` | `app/dashboard/page.tsx` (`DashboardPage`) | Assessment list, "Open now" sittings strip, shares offered to you, and the admin "All teachers" view. |
| `/dashboard/new`, `/dashboard/import`, `/dashboard/uploads` | `app/dashboard/new/`, `import/page.tsx`, `uploads/page.tsx` | Create an assessment, import an exported assessment file, and manage uploaded images. With the R-12 flag on, `/dashboard/new` (and the empty `/dashboard`) shows the start screen: see [the start screen](new-authoring-editor.md#the-start-screen). |
| `/dashboard/[id]` | `app/dashboard/[id]/page.tsx` (`AssessmentEditorPage`) | Editor for one assessment, with the tabs listed below. |
| `/dashboard/[id]/monitor/[sittingId]` | `monitor/[sittingId]/page.tsx` (`MonitorPage`) | Live proctoring view for one sitting. |
| `/dashboard/[id]/results` | `results/page.tsx`, `results/[attemptId]/page.tsx`, `results/print/page.tsx`, `results/work/page.tsx` | Results matrix, one student's attempt, the printable report, and the work packet. |
| `/dashboard/[id]/scoring` | `scoring/page.tsx` (`ScoringPage`) | Teacher review queue; rules are in [scoring and results](scoring-and-results.md). |
| `/dashboard/accommodations` | `accommodations/page.tsx`, `accommodations/[studentId]/`, `accommodations/roster/[psId]/`, `accommodations/import/` | Student accommodation records, TIDE import, and review of changed imports. |

Page guards follow one pattern. A missing staff session redirects to `/login?next=...`. A malformed UUID, or an assessment or sitting the caller cannot reach, calls `notFound()`, so a guessed id learns nothing. `AssessmentEditorPage` and `ScoringPage` resolve the assessment with `authorizeAssessment` or `pageAssessment` at the `edit` level. `MonitorPage` also checks that the sitting belongs to the assessment named in the URL, not only that the caller may monitor it.

## Header, help, roadmap and feedback

`AppHeader` (`components/app/AppHeader.tsx`, rendered by `AppChrome`) is the persistent header on every `/dashboard` and `/admin` page. It holds the Assessments and Students nav nouns, an **Admin** link for admins (`isAdmin(session)`, hidden while impersonating), a **Help** link, a **Send feedback** button, the signed-in identity and Sign out.

- **Help** opens the static page `design-tool/public/help.html` in a new tab. It is not a Next route. `proxy.ts` guards only `/dashboard` and `/admin` (`PROTECTED_PREFIXES`), so the help page is served without a session and must never carry real student, staff or assessment data. Its topics are written to match the app's button labels, and its own upkeep comment requires updating a topic's steps when a UI change touches it. Screenshots come from the help-capture tooling, which is in the [backlog](../quickstart.md#backlog).
- **Roadmap** (`design-tool/public/roadmap.html`) is a second public static page, linked from the help page. Its feedback form posts to the same `/api/feedback` route, with the view name in the message and `path` set to `/roadmap.html#<view>`. A signed-out submission (401) keeps the draft in `localStorage` and offers a sign-in link whose `next` is `/roadmap.html?resume=1#<view>`.
- **Send feedback** opens `FeedbackDialog` (`components/app/FeedbackDialog.tsx`). It posts `{ message, path }` with the current pathname to `POST /api/feedback`. The message is limited to 2000 characters, and the button shows "Could not send. Try again." on failure.

`POST /api/feedback` (`app/api/feedback/route.ts`) is staff-only through `requireStaff()`, so students get 403 and have no button. It validates the body with Zod (`message` 1 to 2000 trimmed characters, `path` up to 500, optional `quiet`), then inserts a `feedback` row carrying the session's sub, email and role, the path, user agent and `APP_COMMIT`. Unless `quiet` is set, it publishes a `[SecureTest] Feedback from <role>` notification through `getNotifyPublisher()`. A failed publish is logged as `feedback_publish_failed` and the request still returns 200 with the row id, because the row is the record and the notification is only a signal. The notification path and retention are in [integrations](integrations.md#notifications) and [deployment and observability](../operations/deployment-and-observability.md).

```mermaid
sequenceDiagram
  participant D as FeedbackDialog
  participant R as POST /api/feedback
  participant DB as feedback table
  participant N as notify publisher
  D->>R: message and path
  R->>R: requireStaff, then Zod body check
  R->>DB: insert feedback row
  alt quiet is not set
    R->>N: publish subject and body
    Note over R,N: a failed publish is logged, not returned
  end
  R-->>D: 200 with row id
```

Caption: the staff feedback write. The row is the record; the notification is best-effort.

Invariants:
- Only staff can write feedback, and the row is written before any notification is attempted.
- Help and roadmap are static, public and content-only. Changing them does not touch authorization.

Change guidance: when a UI label changes, update the matching help topic in the same edit. Focused check: `cd design-tool && bun test test/feedback-api.test.ts`, which covers the stored row, `quiet`, validation, the student 403, the 401, and a throwing publisher. `test/auth-role-enforcement.test.ts` enumerates routes from disk and is the suite to run when adding an API route. No test covers `FeedbackDialog` or the static pages' copy, so check those in a browser.

## Assessment list (`/dashboard`)

`DashboardPage` builds every query on one scope fragment, `visibleAssessmentScope(db, session, { all })`, so the list, the counts, and the "Open now" strip cannot disagree about what the caller may see. The list shows live assessments by default; `?archived=1` shows archived ones instead.

- **Open now** lists sittings whose assessment is visible, whose status is `open`, and whose `expires_at` is still in the future. Each row links to the monitor.
- **Shared with you** lists pending offers from colleagues. Accepting one creates your own copy.
- **All teachers** is an admin-only view. `showAllTeachersToggle` gates the link, and `homeListMode` ignores a hand-typed `?all=1` for non-admins. `ownerCell` renders "you" for rows the caller owns.
- A co-teacher grant that has not been opened yet shows a "New" mark, which is cleared when the editor is opened (`markAssessmentGrantSeen`).

Row actions (`DuplicateAssessmentButton`, `ArchiveAssessmentButton`, `DeleteDraftButton`, `ActAsButton`) call existing API routes. Their rules are in [assessment lifecycle](assessment-lifecycle.md) and [auth and access](auth-and-access.md).

## Assessment editor (`/dashboard/[id]`)

`AssessmentEditor` is one large client component. With the per-staff R-12 flag on, its Questions tab autosaves each question card, shows an outline rail and an insert menu, and offers a per-question History dialog; see [authoring editor beta](new-authoring-editor.md). Its tabs are fixed in `EDITOR_TABS`, and the active tab is kept in `?tab=`, so reload and deep links land on the same panel. `parseTab` falls back to Questions for an unknown value.

| Tab (`?tab=`) | Teacher label | Owns |
|---|---|---|
| `questions` | Questions | Items, item sets, imports, AI generation, and standards tags. See [authoring](authoring.md) and [batch item generation](batch-item-generation.md). |
| `settings` | Settings | Name, time limit, layout, feedback and answer-release settings, the passage-highlighting checkbox ([passage highlighting](passage-highlighting.md)), archive and delete. |
| `accommodations` | Allowed on this test | Assessment-wide allowed list, construct-altering flags, and class-period grants. See [accommodations and roster](accommodations-and-roster.md). |
| `students` | Exceptions for this test | Per-student overrides on this assessment. See [accommodations and roster](accommodations-and-roster.md). |
| `sessions` | Test sessions | `SittingsPanel`: create sittings, show codes, close early, continue an ended class sitting in a new session, and see who has joined or submitted. Extend and hand-in controls are on the monitor. See [sittings and attempts](sittings-and-attempts.md). |

The editor receives `access.level`, `access.via`, and `owner_email` from the server. Owner-only actions in the header and Settings tab use them, and a co-teacher's editor is labelled as such. A published assessment shows a lock banner; answer keys and standards stay editable while it is locked, as described in [assessment lifecycle](assessment-lifecycle.md).

## Monitor (`/dashboard/[id]/monitor/[sittingId]`)

`MonitorView` is the proctoring screen for one sitting: one card per student, with the join code large enough for a projector. It starts from server props (`code`, `status`, `expiresAt`, `kind`, and whether the assessment is untimed), then replaces them with the live payload.

Polling is the core behaviour. A tick runs every `LIVE_INTERVAL_MS` (5 seconds, from `attendanceView.ts`) while the sitting is open or any student is still `in_progress`. Ticks are skipped while the document is hidden, and a `visibilitychange` handler stops the timer and refreshes once on return. Controls on the page are `ExtendTimeControl`, `HandInAllControl`, `ShowCodeDialog`, and a confirmed Close. The server rules those controls call are owned by [sittings and attempts](sittings-and-attempts.md).

```mermaid
flowchart TD
    A["Dashboard Open now strip"] --> B["Monitor page: pageSitting run"]
    B --> C["MonitorView server props"]
    C --> D{"open or any in_progress?"}
    D -->|yes| E["Poll every LIVE_INTERVAL_MS while visible"]
    D -->|no| F["Static view"]
    E --> G["Extend, hand in all, close"]
```

The monitor polls only while there is something left to watch, and each control calls an existing sitting route.

Each student row also has a **View screen** control (`ViewScreenControl` in `MonitorView.tsx`), enabled only while that attempt is `in_progress`. Clicking it posts `POST /api/attempts/[attemptId]/peek`, then polls `GET /api/attempts/[attemptId]/peek/image` every 2.5 seconds for up to 40 seconds. The GET deletes the image as it returns it, so this row is the only reader and polls only while it waits. The frame opens in `ViewScreenDialog` (`components/app/ViewScreenDialog.tsx`), which holds it in component state only, so closing the dialog discards it. The student's side of the cycle and the server windows are in [events and the monitor](sittings-and-attempts.md#events-and-the-monitor).

On an ended class sitting, the header offers **Continue in a new session**, and a banner appears while any student is still `in_progress` to explain that Adjust time alone does not let anyone back in. The rules are in [sittings and attempts](sittings-and-attempts.md#ending-a-sitting-and-continuing-it).

## Results, scoring, and reports

`results/page.tsx` renders `buildResults` with a `sectionFilterOptions` filter; a `NO_SECTION` value covers rows that resolve to no section. Per-attempt actions are small client components that call a route and reload: `ChangeScoreAndReload`, `RescoreAndReload`, `PassBackAndReload`, `ReleaseAnswersAndReload`, `SendToGradebookAndReload`, `HandInAttemptAndReload`, `HandInInProgressAndReload`, `ExtendTimeAndReload`, and `DeleteAttemptAndReload`. Item analytics come from `results/analyticsQuery.ts`, and the class-insights panel is `components/app/ClassInsightsPanel.tsx`.

`scoring/ScoringQueue.tsx` is the review queue for human-method items and AI proposals, with a Section select kept in the address bar and a last list, "Finalized by AI — not reviewed", for Hybrid scores no teacher has reviewed. Its rules are in [scoring and results](scoring-and-results.md#teacher-review-queue-and-approval) and [Hybrid and unreviewed AI scores](scoring-and-results.md#hybrid-and-unreviewed-ai-scores). The printable pages are described in [reporting and work packets](reporting-and-packets.md).

## Accommodations pages

`accommodations/page.tsx` loads the teacher's student records together with `pendingTideDiffs` and `otherTeachersRecords`, and shows the count of changes to review. The TIDE import flow is `accommodations/import/ImportTidePanel.tsx`, and review is `import/review/DiffReviewPanel.tsx`. The student editor is `[studentId]/StudentEditor.tsx`. The rules and data behind these pages are in [accommodations and roster](accommodations-and-roster.md).

## System admin pages

`/admin` is the one deliberately unscoped page in the staff UI. `AdminPage` lists every test session whose status is `open` and whose `expires_at` is in the future, across all teachers, newest first. Each row shows the code, assessment, owning teacher, section (or "Practice" for a practice sitting) and start time. Its actions are a **Monitor** link to the sitting's monitor and an **Act as** button for a sitting owned by someone else. Its header line counts open safeguarding alerts district-wide and links to `/admin/safeguarding`, where the list is open alerts by default (`adminAlertMode`, `?show=all` for every alert). Acknowledging an alert is a teacher action, not an admin one.

Admin status comes from `ADMIN_EMAILS` through `isAdmin` (`lib/auth/admin.ts`), as described in [auth and access](auth-and-access.md). Both pages return 404 to a non-admin, and an impersonated session is never admin, so the act-as banner hides the admin surface until the session ends. The grants console is not on these pages; the page source records that the `/api/grants` route has no UI yet. Safeguarding alert rules are in [AI and safeguarding](ai-and-safeguarding.md#hand-in-screening-and-alerts).

Focused tests: `test/admin.test.ts` (the admin and impersonation predicate) and `test/safeguarding-alerts-ui.test.tsx` (`adminAlertMode` and the admin alert page). The page itself needs the test database for the render test.

## Shared components

`components/app/` holds the dialogs and controls used across these pages, for example `PublishDialog`, `ShareDialog`, `GenerateQuestionsDialog`, `SuggestStandardsDialog`, `SafeguardingPanel`, and `SendToGoogleDocsControl`. `components/ui/` holds the shared UI primitives. `AppChrome` resolves the header from the session and is shared with `/admin`; it shows the act-as banner when the session is an impersonation.

### Teacher-facing error copy

Routes answer with machine codes (for example `already_granted`, `ends_at_past`). `lib/ui/errorCopy.ts` turns a code into one sentence a teacher can act on, and each panel calls the helper for its own surface: `itemErrorCopy` in the assessment editor, `sessionErrorCopy` and `attemptDeleteErrorCopy` on sittings and the monitor, `attemptHandInErrorCopy`, `extendErrorCopy` and `passBackErrorCopy` on attempt controls, `accommodationErrorCopy` and `tideImportErrorCopy` on accommodations, `coTeachErrorCopy` in the share dialog, `importErrorCopy` and `uploadErrorCopy` on import and uploads, and `authErrorCopy` on the login page. Each helper returns `{ message, showCode }`. `showCode` is true when the fix belongs to IT rather than the teacher, so the raw code stays visible for search. An unknown code falls back to a generic message that still shows the code. A new route code therefore needs a case in the matching helper, or the teacher sees the fallback. Tests `co-teach-ui.test.tsx` and `pass-back-control.test.tsx` pin the exact wording for their helpers. Copy rules are not enforced by the routes, so a wording change is a UI-only change.

## Change navigation

- **Where to start.** Find the route in the route map, then read its page source. Rules usually live behind `lib/api/*`, not in the page.
- **Invariants.** Visitors without a staff session are redirected to login. An assessment or sitting the caller cannot reach is a 404, not a forbidden panel. The All-teachers view is admin-only. The monitor polls only while a sitting is open or a student is still working.
- **Focused tests.** `test/all-teachers-ui.test.ts` (toggle and list-mode helpers), `test/reporting-views.test.tsx` (the assessments list and results matrix), `test/co-teach-ui.test.tsx` (owner and co-teacher labels), `test/attendance-view.test.ts` (monitor state), `test/extend-time-control.test.tsx`, `test/hand-in-all-control.test.tsx`, and `test/access-enforcement.test.ts` (route-level 404s).
- **Minimal validation.** `cd design-tool && bun test test/all-teachers-ui.test.ts` for the list helpers. Database-backed suites need `DATABASE_URL`, as set out in [testing and validation](../testing/testing-and-validation.md).
- **Scope boundary.** Changing a button's behaviour usually means changing the route or `lib/api` helper, not the component.

Related pages: the [architecture overview](../architecture/overview.md) gives the system context, and the [data model](data-model.md) covers the tables behind these pages.

