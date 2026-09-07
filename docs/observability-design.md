# Observability — error tracking on both sides, and a feedback button

Design page, 2026-09-03. Decisions marked **D-n** are James's (2026-09-03);
recommendations not yet decided are marked as such. Batch 3 of
`docs/roadmap-2026-09.md`. Two of James's four adds live here because they
share everything: the outbound channel (an SNS topic that emails James),
the events-table pattern, the version stamp from the release plan, and one
deploy.

## What exists that this stands on

**Design tool.**
- ~20 bare `console.warn` / `console.error` sites and nothing structured
  except the roster importer's JSON-lines logger (`lib/roster/syncHandler.ts`
  `consoleJsonLogger` — `event`, `status`, `reason`, `run_id`), which is
  the model to copy.
- No `instrumentation.ts`, no `onRequestError`, no request id. One error
  boundary, scoped to `/dashboard` (`app/dashboard/error.tsx`), which
  shows `error.digest` as a reference "to hand IT" — the only correlation
  handle between a screen and a CloudWatch line, and nothing indexes it.
  No root `app/error.tsx`, no `app/global-error.tsx`; `/login` and
  `/preview` have no boundary. `proxy.ts` returns a `text/plain` 500 on a
  missing session secret.
- Infra (`design-tool/infra/lib/app-service.ts`): the CDK default
  `awslogs` driver into a generated log group with **no retention** (rows
  never expire); **zero alarms, zero SNS topics, zero metric filters**; the
  ECS circuit breaker's alarm list is empty; the ALB health check hits
  `/api/health`, a liveness probe with no DB read. The roster Lambda logs
  counts only, no alarm on failure. No APM dependency anywhere.
- Precedent tables in `db/schema.ts`: `guardrail_events` (redaction
  contract — truncated snippet, suppressed on sensitive findings — and an
  explicit "rows are never expired today" warning), `roster_sync_runs`
  (per-run status), `attempt_events` (kind CHECK constraint, server-stamped
  `at`, `detail jsonb`; `ALERT_EVENT_KINDS` drive the monitor's "Needs
  attention"), `peek_requests`.
- No feedback UI or route. No outbound email of any kind (no SES,
  nodemailer, SNS). The session carries `sub`, `email`, `role`
  (`lib/auth/session.ts`), so a feedback payload needs no new plumbing to
  know who sent it. The `taskRole` already carries the asset-bucket and
  Bedrock grants.

**Client.**
- One sink: stderr, unstructured, `[security]`-prefixed
  (`AppDelegate.log`, injected as a closure everywhere). No `os_log`, no
  file, no verbosity knob. The dev launcher redirects stderr to
  `~/securetest-student.log`; a double-clicked build produces logs nobody
  can read.
- Failure-shaped sites already shout: `BUNDLE FETCH FAILED`, `BUNDLE
  REJECTED`, `SUBMIT FAILED`, `DRAWING UPLOAD FAILED`, `SPOOL FAILED`,
  `responses DROPPED`, the `BLOCKED …` family, `event <kind> not delivered`
  (`AssessmentViewController.swift`, `AttemptEventReporter.swift`).
- No crash handling: no `NSSetUncaughtExceptionHandler`, no signal
  handler. The one hard exit is `exit(70)` from `lockdown.onUnrecoverable`
  with the main thread presumed gone — only a synchronous write can
  survive it.
- The events channel (`AttemptEventReporter` → `APIClient.postEvent` →
  `POST /api/attempts/[attemptId]/events`) is a working, retrying (four
  attempts, 2 / 4 / 8 s for lifecycle kinds), alerting pipe — but
  **attempt-scoped and student-authed**: it cannot carry an error from the
  sign-in screen, the sittings list, a failed join, or a crash on the next
  launch. Swift `detail` is `[String: String]`; the server accepts
  `Record<string, unknown>`.
- The only persisted state is the response spool,
  `~/Library/Application Support/SecureTest/responses.sqlite` inside the
  sandbox container — the one place a client log can live. The session JWT
  is in-memory only, so anything drained after a relaunch waits for a
  sign-in.

## Proposed shape

### Server errors

- **`instrumentation.ts` with `onRequestError`** (read the Next 16 docs in
  `node_modules/next/dist/docs/` first — this version differs): every
  unhandled route / server-component error writes one JSON log line
  (`level: "error"`, `event: "request_error"`, `route`, `method`,
  `status`, `digest`, `message`, a stack hash, `request_id`, `sub` when a
  session exists — never a body, never a query string) and one row in a
  new **`server_error_events`** table with the same fields plus a truncated
  stack (2 000 chars). A request id is minted in `proxy.ts` (or read from
  the ALB's `x-amzn-trace-id`) and echoed as a response header, so a
  teacher's "ref" on screen matches a row and a log line.
- **Boundaries:** root `app/error.tsx` and `app/global-error.tsx` in the
  `dashboard/error.tsx` style (Alert, "Try again", the ref); `proxy.ts`'s
  500 becomes a real page with the same ref.
- **Infra:** an explicit `LogGroup` with **retention 30 days**
  (recommended, D-8 below — the DB is the record; logs may carry student
  ids); a **metric filter** on `level: "error"` → alarm (≥ 1 in 5 min) →
  the SNS topic; ALB target 5xx alarm; ECS `RunningTaskCount < 1` alarm;
  the roster Lambda's errors alarm. The circuit breaker stays.

### Feedback (D-2: simple — SNS email)

- **`feedback`** table: `id`, `sub`, `email`, `role`, `path`, `message`
  (≤ 2 000 chars), `user_agent`, `app_commit`, `created_at`.
- `POST /api/feedback` (staff session required; students have no button —
  they tell the teacher): validates, inserts, then `sns:Publish` to the
  topic with a plain-text body (who, where, when, the message, the
  commit). The row is the record; the email is the notification; a
  publish failure is logged and the row still stands (never a 500 on a
  teacher who is already frustrated).
- UI: "Send feedback" in `AppHeader` → a small dialog (textarea, the
  current path shown, Send / Cancel) → the `StatusLine` confirms. No toast
  system exists and none is added.
- Infra: one topic `secure-test-notify-dev` with James's email
  subscription (confirm once); `taskRole` gains `sns:Publish` on that
  topic only. Alarms publish to the same topic (D-9, recommended: one
  topic, one inbox rule).

### Client errors

- **A container-side error log**, `~/Library/Application
  Support/SecureTest/errors.log` (JSON lines), opened at launch and kept
  open. `AppDelegate.log` gains a companion `logError(kind, message,
  context)` that writes a line synchronously and still writes stderr. The
  failure-shaped sites above call it. Every line carries the version
  stamp (`CFBundleShortVersionString` + the git sha injected at build —
  `docs/client-release-plan.md`).
- **Crash capture, best effort:** `NSSetUncaughtExceptionHandler` and a
  signal handler for `SIGABRT` / `SIGSEGV` / `SIGBUS` / `SIGILL` /
  `SIGTRAP` that `write(2)`s one pre-formatted line (signal name, version
  stamp, the attempt id if any) to the pre-opened descriptor and re-raises.
  Nothing else in a signal handler — no allocation, no Swift strings
  built there. `exit(70)` writes the same way before exiting.
- **Drain on the next signed-in launch:** after sign-in, the app reads
  `errors.log`, `POST`s up to 50 entries to a new **`/api/client-errors`**
  (student session required, not attempt-scoped), truncates the file on
  200, keeps it otherwise. Server: **`client_error_events`** (`sub`,
  `app_version`, `app_commit`, `kind`, `message`, `context jsonb`,
  `occurred_at` from the client, `received_at` server-stamped) — capped
  per request, messages truncated, never response text or stems.
- **In-attempt errors also as an event (D-4):** a new `attempt_events`
  kind **`client_error`** joins `ALERT_EVENT_KINDS`, so the monitor row
  reads "Needs attention" live; posted fire-and-forget through the
  existing reporter (retried like lifecycle kinds), detail `{ kind,
  message }`. Both closed sets and the DB CHECK constraint change in
  lockstep — **migration 0028** — and the Swift `detail` type widens to
  `[String: Any]`-encodable (`[String: String]` stays the common case).

### Redaction and retention (both sides)

- Never: response text, stems, choices, student names, tokens, headers,
  bodies. Yes: `sub`, uuids (attempt, item, assessment), route paths,
  status codes, digests, messages truncated to 2 000 chars, stack hashes.
- Log group 30 days. The three tables: no sweep in v1, indexed on
  `created_at`, and the same explicit "never expired today" note as
  `guardrail_events` — a retention sweep is one follow-up for all four.
- An admin "errors" page is deferred (D-10, recommended): the role model
  has no admin claim yet (`docs/design-tool-plan.md`, the safeguarding
  page's blocker); the email + tables cover the pilot.

## Slices

1. **Infra** (`design-tool/infra`): explicit log group + retention, the
   topic + subscription, `sns:Publish` on `taskRole`, metric filter +
   alarm, ALB 5xx alarm, ECS task-count alarm, Lambda errors alarm; `cdk
   diff` reviewed; deploy is James's. Size S. Sonnet 5 / medium.
2. **Server errors + tables**: migration 0028 (`server_error_events`,
   `client_error_events`, `feedback`, the `attempt_events` kind), the JSON
   logger (`lib/log.ts`, copied from `consoleJsonLogger`), `instrumentation.ts`
   `onRequestError`, request id in `proxy.ts`, root + global boundaries,
   the `proxy.ts` 500 page. Tests: the logger's shape; `onRequestError`
   writes a row and a line (unit, with a fake db); boundaries render the
   ref; `attempt_events` accepts `client_error` and the attendance view
   flags it. Size M. Opus 5 / high.
3. **Feedback**: table use, route, dialog, publish (a stub publisher in
   tests). Tests: route validation, row written, publish called with the
   redacted body, a publish failure still returns 200. Size S. Sonnet 5 /
   medium.
4. **Client**: `errors.log` sink + `logError`, the crash / signal handler,
   `exit(70)` write, the drain after sign-in + `POST /api/client-errors`,
   the `client_error` event kind + widened detail, the version stamp read
   from the bundle. Tests: the sink's line shape and truncation
   (`swift test`, file in a temp dir); the drain's batching and the
   keep-on-failure rule against a stub client; `AttemptEventKind` round
   trip. The signal path is hand-run (a debug menu item that raises
   `SIGABRT` behind `SECURE_TEST_DEBUG_CRASH=1`). Size M. Opus 5 / high.
5. **Rows**: design-tool (a forced error shows a ref, the row exists, the
   email arrives; feedback round trip; the alarm fires on a synthetic
   error) and client (a failed join lands in `errors.log` and drains after
   the next sign-in; a debug crash is captured; an in-attempt error lights
   the monitor).

## Decisions

- **D-2 (James) transport = SNS email.** D-3 (James) in-house. D-4 (James)
  `client_error` attempt-event kind.
- **D-8 (James, 2026-09-07: accepted) log retention 30 days.** Versus 90: operational
  logs only; the tables hold what a report needs.
- **D-9 (James, 2026-09-07: accepted) one topic** for alarms and feedback; James filters
  by subject.
- **D-10 (James, 2026-09-07: accepted) no admin errors page in v1**; revisit with the role
  model.
- **D-11 (James, 2026-09-07: accepted) crash capture is best effort**, no symbolication,
  no third-party crash reporter; the signal line plus the last error lines
  are what a classroom Mac can honestly give.

## Progress

**Slice 1 BUILT 2026-09-07 (infra, `9d7231d`)**: explicit log group with
30-day retention (D-8), the `secure-test-notify-<env>` topic + email
subscription from context key `notifyEmail` (D-9), `sns:Publish` on the
task role + `NOTIFY_TOPIC_ARN`, four alarms (metric filter on
`level: "error"`, ALB target 5xx, ALB `HealthyHostCount` < 1 for 2 min —
chosen over ECS `RunningTaskCount`, which needs Container Insights — and
the roster importer's Errors). `cdk diff` reviewed: adds only, the old
generated log group orphaned, task def replaced. Deploy waits for slice 3.

**Slice 2 BUILT 2026-09-07 — server errors + tables.** Migration
`0028_observability_tables.sql` creates `server_error_events`,
`client_error_events` and `feedback` (each indexed on its time column, each
carrying the "rows are never expired today" note `guardrail_events` has) and
replaces the `attempt_events` kind CHECK so it admits `client_error`; applied
to the local test database, NOT yet to dev or Aurora. `ATTEMPT_EVENT_KINDS`
and `ALERT_EVENT_KINDS` in `design-tool/db/schema.ts` gained `client_error` in
the same commit — the closed set lives there, not in `packages/schema` (that
package holds the item/delivery wire formats and never knew about event
kinds), so nothing there changed and no `dist` rebuild is part of this slice.

What landed beside the migration:

- `lib/log.ts` — JSON-lines logger in `consoleJsonLogger`'s shape with a
  `level` added (`error` / `warn` / `info`), an injectable sink for tests, and
  the redaction contract written out at the top: `sub`, uuids, route paths,
  methods, statuses, digests, counts, truncated messages and stack hashes may
  be logged; bodies, query strings, headers, tokens, response text and stems
  may not. `routeOf` and `truncate` are the two mechanical helpers; the rest
  is review.
- `lib/observability/serverError.ts` + `instrumentation.ts` — Next 16's
  `onRequestError` (its docs are
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`;
  note it hands over no status, so the row records 500). One `level: "error"`,
  `event: "request_error"` line and one `server_error_events` row per
  unhandled error, sharing route / method / status / digest / message / stack
  hash / request id / sub. A failing row write logs
  `request_error_not_recorded` and resolves — the log line is the primary
  record and an unhandled rejection inside Next's error handler would be
  worse. `db/client` and `db/schema` are imported lazily so the hook stays
  loadable in the Edge runtime.
- `lib/observability/requestId.ts` + `proxy.ts` — the id is the ALB's
  `x-amzn-trace-id` when present, else a uuid; an inbound value that is not
  id-shaped is discarded. It is set on the request (so `onRequestError` reads
  it back out of the headers) and echoed as the `x-request-id` response
  header. The matcher had to widen from `/dashboard` to
  `/((?!_next/static|_next/image|favicon.ico|icon.png|.*\.woff2$).*)`;
  `isProtected` still decides who gets the auth treatment, so no auth
  behaviour moved.
- `app/error.tsx`, `app/global-error.tsx`, and `proxy.ts`'s misconfigured
  page — three surfaces, one wording, one "ref". `global-error` replaces the
  root layout so it renders its own document with inline styles (no
  globals.css); the proxy's page is hand-written HTML for the same reason and
  replaces the old `text/plain` 500.
- `POST /api/client-errors` — contract below.
- `POST /api/attempts/[attemptId]/events` accepts `client_error`, and reduces
  its `detail` to `{ kind, message }` (message truncated to 2 000) at the
  write boundary: the monitor renders `detail`, so this is where a client is
  stopped from putting an answer or a stem in front of a teacher.
  `eventLabel("client_error")` is "The app hit a problem".

Tests: design-tool 1135 → **1172 pass**, 0 fail (37 added — the logger's line
shape and the redaction helpers; `onRequestError`'s line + row with an
injected writer, the swallowed DB failure, truncation, the dropped query
string, stack-hash grouping; the three boundaries rendering the ref;
`/api/client-errors` validation / cap / rows / student-only; `client_error`
accepted, folded into attendance as a sticky alert, and labelled).
`bun run typecheck` clean. `/api/client-errors` was added to
`STUDENT_ROUTES` in `test/auth-role-enforcement.test.ts`.

Not done here and still open for slice 1 / 5: nothing is deployed, the
migration has not run on dev or Aurora, and there is no log group, metric
filter, alarm or SNS topic yet (slice 1). No retention sweep for the new
tables (the whole-batch follow-up).

### `POST /api/client-errors` — the contract slice 4 writes against

Student session required (bearer or cookie); a staff session gets 403, no
session 401. Not attempt-scoped.

```
POST /api/client-errors
Authorization: Bearer <session JWT>
Content-Type: application/json

{ "errors": [
    { "kind": "bundle_rejected",            // ≤ 120 chars, a short code
      "message": "BUNDLE REJECTED: …",      // truncated server-side to 2000
      "context": { "attempt_id": "…" },     // optional; ≤ 4 KB of JSON
      "occurred_at": "2026-09-06T18:22:04Z",// ISO 8601 with an offset
      "app_version": "1.0.0",
      "app_commit": "abc1234" } ] }
```

- At most **50** entries per request. More → **413**
  `{ "ok": false, "error": "too_many_entries", "max": 50 }` and nothing is
  stored, so the client should split the batch rather than drop the file.
- A malformed body (empty array, missing field, non-ISO `occurred_at`) →
  **400** `{ "ok": false, "error": "invalid_body" }`, nothing stored.
- A `context` whose JSON exceeds 4 KB is replaced by
  `{ "dropped": "context_too_large" }` — half a bag is worse than none.
- Success → **200** `{ "accepted": n }`. The insert is one statement, so
  there is no partial batch and the client's "truncate `errors.log` on 200,
  keep it otherwise" rule is safe.
- `sub` is taken from the session and never from the body. `received_at` is
  server-stamped; `occurred_at` is the client's clock, which is the point.
- Never send response text, stems, choices, tokens or student names — the
  server does not filter the message, and the redaction rule is the client's
  to keep.

In-attempt errors do NOT come here: they go to
`POST /api/attempts/[attemptId]/events` as
`{ "kind": "client_error", "detail": { "kind": "<code>", "message": "<text>" } }`
so the teacher's monitor shows "Needs attention" live. `detail` is reduced to
exactly those two fields server-side; anything else is dropped.

**Slice 4 (Client) BUILT 2026-09-07.** `errors.log` exists:
`ClientErrorLog` (Core) opens
`~/Library/Application Support/SecureTest/errors.log` — the sandbox
container, beside `responses.sqlite` — once at launch and keeps the
descriptor for the life of the process, writing one JSON object per line
(`occurred_at`, `kind`, `message` capped at 2 000, `context`,
`app_version`, `app_commit`, `attempt_id` when one is open) synchronously
under a lock. `AppDelegate.logError(kind:message:context:)` is the
companion to `log`: the file line, the same text on stderr through the
sink's `echo`, and — while an attempt is open — a `client_error` attempt
event through the existing `AttemptEventReporter` (D-4; the kind is in
`retriedKinds`, and a `client_error` that cannot be posted is guarded
against manufacturing another). Every failure-shaped site the page lists
calls it: `BUNDLE FETCH FAILED`, `BUNDLE REJECTED`, `SUBMIT FAILED` (plus
the "answers still unsent" refusal), `DRAWING UPLOAD FAILED`, both
`SPOOL FAILED`s, `responses DROPPED`, the whole `BLOCKED …` family
(through one `blocked(_:detail:)` helper, stderr text unchanged), `event
<kind> not delivered`, a failed join (list and code), a failed
`my-sittings`, a failed sign-in and a refused token exchange, and a peek
upload that never landed. The version stamp is `AppVersion` (slice 1 of
the release plan) handed to Core as `AppBuildStamp`.

Crash capture is `CrashReporter` (D-11, best effort, no symbolication):
`NSSetUncaughtExceptionHandler` plus handlers for SIGABRT / SIGSEGV /
SIGBUS / SIGILL / SIGTRAP. Every line those can write is built ahead of
time in ordinary code and parked in C memory; the handler scans a
six-slot array, `write(2)`s the matching buffer to the already-open
descriptor, and re-raises with `SIG_DFL`. Nothing else — no allocation,
no Swift String, no lock. The lines carry the signal name from a static
table, the version stamp and the attempt id, and deliberately carry NO
`occurred_at` (a handler cannot read a clock); the drain stamps its own
time on those. The attempt id is re-prepared when an attempt starts and
when the entry screen returns, and the superseded buffers are leaked on
purpose rather than freed under a possible concurrent signal.
`lockdown.onUnrecoverable` writes its own parked line the same way before
`exit(70)`.

The drain (`ClientErrorDrain`) runs after a successful sign-in — and once
at entry, for the `--token` dev path — detached and never awaited. It
reads the file, posts batches of 50 to `POST /api/client-errors` through
`APIClient.postClientErrors`, and removes lines from the FRONT only for
what the server accepted, so a mid-way failure keeps the rest and a line
appended while a POST was in flight is never dropped. `AttemptEventKind`
gained `client_error`; the Swift `detail` stayed `[String: String]`,
which the `{ kind, message }` shape needs nothing more than.

Tests: `swift test` 365 → 387 (new `ClientErrorLogTests`,
`ClientErrorDrainTests`, `CrashReporterTests`; the existing wire-name
test gained `client_error`). `xcodebuild … build` green. The signal path
itself, the drain against a real server, the monitor lighting up and the
`exit(70)` line are twelve hand-run rows in `client/MANUAL-CHECKS.md`
("Observability slice 4"), NONE run — including the debug crash trigger,
which is a Session-menu item present only under
`SECURE_TEST_DEBUG_CRASH=1`.

**Slice 3 BUILT 2026-09-07 — feedback.** `lib/notify/` follows the
`lib/storage/` provider shape exactly: a `NotifyPublisher` interface
(`publish(subject, body)`), `mockProvider.ts` (default, records calls in a
`notifications[]` array with a `resetMockNotifications()` test seam),
`snsProvider.ts` (`@aws-sdk/client-sns`'s `PublishCommand` against
`NOTIFY_TOPIC_ARN`, region from `NOTIFY_REGION || AWS_REGION || us-west-2`,
credentials off the standard chain — the task role once deployed, same as
`s3Provider.ts` and the Bedrock client), and `provider.ts` selecting by
`NOTIFY_PROVIDER` (`mock` default, `sns` the only other id). The dependency
is `@aws-sdk/client-sns` pinned `^3.1069.0` to match the other AWS SDK
packages already in `package.json` (resolved 3.1127.0 by `bun add`).
`NOTIFY_PROVIDER` and `NOTIFY_TOPIC_ARN`/`NOTIFY_REGION` were NOT added to
`.env.local.example` — that path is denied to this session by permission
settings regardless of tool, so the two vars are documented here instead:
`NOTIFY_PROVIDER=sns` (else it stays `mock`), `NOTIFY_TOPIC_ARN=<the topic
from slice 1's infra>`, optional `NOTIFY_REGION` (defaults to
`AWS_REGION || us-west-2`).

`POST /api/feedback` (`requireStaff()`; no `STUDENT_ROUTES` entry needed —
`test/auth-role-enforcement.test.ts` enumerates it from disk and a plain
staff route is its default case) validates `{ message: string (1..2000,
trimmed), path: string (≤500) }` with zod, reads `user_agent` off the
request header (≤500, truncated), reads `app_commit` from
`process.env.APP_COMMIT ?? null` (no existing build-commit constant on the
server side — `/api/health` reads nothing and the client's `AppVersion`
stamp has no server equivalent), inserts one `feedback` row with `sub` /
`email` / `role` off the session, then calls `getNotifyPublisher().publish()`
with subject `[secure-test] Feedback from <role>` and a plain-text body
(who/where/when/message/commit — nothing else). A throwing publisher is
caught, logged as `feedback_publish_failed` (`sub`, the row's id, the
truncated error message) via `lib/log.ts`, and the route still answers `200
{ ok: true, id }` — the row is the record, per the design page.

UI: `AppHeader` gained a "Send feedback" button (staff-only, because
`AppHeader` itself only renders for a staff session — `app/dashboard/layout.tsx`
already gates it) opening `FeedbackDialog` (`components/app/FeedbackDialog.tsx`):
the shadcn/Radix `Dialog` used by `ShareDialog`/`PublishDialog` (Escape and
focus-trap come from Radix for free; `onOpenAutoFocus` is overridden to focus
the textarea specifically), a read-only `path` field, a `Textarea` capped at
2000 characters with a live "n / 2000" counter, Send / Cancel. `StatusLine`
gained a `{ kind: "success"; message: string }` variant (parallel to the
existing `failed` shape) so the dialog can show "Thanks — sent." without a
new toast system; on success the dialog closes ~900ms later, on failure it
shows "Could not send. Try again." and stays open.

Tests: design-tool 1172 → **1180 pass**, 0 fail (8 added in
`test/feedback-api.test.ts`, following `test/client-errors-api.test.ts`'s
shape): empty/too-long/missing-path validation, a student session 403, a row
written from the session's sub/email/role, the mock publisher's recorded call
containing the message/email/path and nothing header/token-shaped, a throwing
publisher still yielding 200 with a `feedback_publish_failed` log line, and
the mock publisher's own record-keeping. `bun run typecheck` clean. No render
test for `FeedbackDialog`: the repo's one `.tsx` test
(`test/error-boundaries.test.tsx`) only exercises static server-rendered
markup via `renderToStaticMarkup`, and there is no jsdom/testing-library
harness for a stateful client component with hooks, so a UI test was skipped
rather than bolting one on ad hoc — this is called out, not silently
dropped. Hand-run rows 62–66 are new in
`docs/design-tool-manual-checks.md` ("Observability slice 3 (feedback)"),
NONE run — the email-arrival half of row 64 additionally waits on slice 1's
topic being deployed with a confirmed subscription.

**Slice 3 review note (2026-09-07):** the container now gets
`NOTIFY_PROVIDER=sns` from infra beside `NOTIFY_TOPIC_ARN` (the agent's
route read it but nothing set it). `feedback.app_commit` reads
`APP_COMMIT`, which nothing injects yet — the server has no build stamp
(the client's `PSDBuildCommit` has no server twin). Follow-up: a Docker
build arg → `APP_COMMIT` in the image, surfaced on `/api/health` too.
`.env.local.example` could not be edited from the session (`.env*` is
denied); James adds `NOTIFY_PROVIDER=mock` / `NOTIFY_TOPIC_ARN=` /
`NOTIFY_REGION=` lines by hand.

**DEPLOYED 2026-09-07 ~09:57 PT — task def rev 12, rollout COMPLETED,
/api/health 200 with `x-request-id`; Aurora at 0028 via migrate-aurora
(the script already reads the new log group).** First `cdk deploy` stopped
at the IAM approval prompt (the backgrounded `!` command had no TTY —
`--require-approval never` on the re-run) and its `next build` warned
that `serverError.ts` pulled `node:crypto` into the Edge instrumentation
bundle → `6dc7418` gates `onRequestError` on `NEXT_RUNTIME` with a dynamic
import (the Next 16 doc pattern).

**Slice 5 rows, teacher side, 2026-09-07 (Claude in Chrome on the origin):**
rows 62–68 in `docs/design-tool-manual-checks.md`. Feedback: dialog / counter
/ Cancel / Escape / draft-cleared ✅; send → 200, no publish-failure line, but
the confirmation shows inline in the dialog, which then closes on its own (O-1 withdrawn on the second pass); no-session 401 ✅, the
student 403 half unit-tested only. Server error: **not forceable** on the
origin (every id-taking route validates first) — row 67 stays open until a
real 500 or a debug throw behind an env knob. Alarm path: one synthetic
`level:"error"` line put into the log group → `ServerErrorsAlarm` ALARM 77 s
later and the SNS action executed ✅. **Email delivery unproven: the
subscription was `PendingConfirmation`** — James confirms, then one feedback
send is the last teacher-side check. Client rows ("Observability slice 4",
`client/MANUAL-CHECKS.md`) wait on James at the keyboard with the rebuilt
app (`SECURE_TEST_DEBUG_CRASH=1` for the crash row).

**SNS gotcha 2026-09-07:** the click-confirmed subscription was unsubscribed
within a minute of the first alarm email — twice — by the district mail
path's link scanner following the one-click Unsubscribe link every SNS email
carries. Fix: `aws sns confirm-subscription … --authenticate-on-unsubscribe
true` with the token from the confirmation URL (infra README has the
recipe); the CLI-made subscription lives outside the stack.
