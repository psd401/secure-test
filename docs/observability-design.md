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
- **D-8 (recommended) log retention 30 days.** Versus 90: operational
  logs only; the tables hold what a report needs.
- **D-9 (recommended) one topic** for alarms and feedback; James filters
  by subject.
- **D-10 (recommended) no admin errors page in v1**; revisit with the role
  model.
- **D-11 (recommended) crash capture is best effort**, no symbolication,
  no third-party crash reporter; the signal line plus the last error lines
  are what a classroom Mac can honestly give.

## Progress

Nothing built. Slice 1 first (it is what every other slice publishes to).

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
