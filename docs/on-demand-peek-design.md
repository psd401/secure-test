# On-demand peek — design (draft 2026-08-28)

The last open Phase 2 feature (plan.md "Phased Roadmap"): a teacher looks at
one student's test screen, once, on purpose — 1:1, teacher-initiated,
student-notified, ephemeral. Not a thumbnail grid (dropped, finding #13), not
a stream, not surveillance-by-default.

## The measured foundation

Screen capture is dead inside AAC: ScreenCaptureKit returns the assessment
window as a flat grey box during a real session, `allowsScreenshots` true or
false (PoC-A RESULTS finding #13). The replacement was measured the same day
(finding #14, `poc-a-aac-capture/.../ScreenCaptureService.swift`):
`NSView.cacheDisplay(in:to:)` — the app rendering its own view tree in
process — survives the session with full content, no window-server capture,
no TCC grant, main-thread only. So the client renders itself and pushes the
image; the server and teacher never touch the screen.

## Shape (proposed)

One DB-backed request/response cycle; no new transport (monitor v2's
polling decision applies — the app is one Fargate service away from
multi-instance, so nothing lives in process memory).

```
teacher (monitor card)                server                        client
  "Peek" ────────────────▶ POST peek request (row, TTL)
                                                    ◀──── GET pending peek?
                                                          (poll while attempt
                                                           open, ~5 s)
                                                    banner shown to student
                                                    cacheDisplay → JPEG
                                       ◀──────────── POST image
  monitor poll picks up
  "ready" ───────────────▶ GET image (deleted on read / TTL sweep)
```

- **Request**: `POST /api/attempts/:attemptId/peek` (staff; same owner check
  as the monitor — the sitting's owner only). At most one open request per
  attempt; re-request replaces. (The peek surface is four single-role routes
  — `peek` POST and `peek/image` GET staff, `peek/pending` GET and
  `peek/upload` POST student — so the slice-58 role sweep classifies each
  file whole; built as P1, 2026-08-28.)
- **Client discovery**: the client polls
  `GET /api/attempts/:attemptId/peek/pending` (student session, own attempt
  — the slice-91 auth pattern) every ~5 s while a server-delivered attempt
  is open. Peek latency ≈ poll interval + render + upload, so ~5–8 s
  teacher-click-to-image.
- **Student notification**: the banner appears AT REQUEST TIME, before any
  pixel leaves the machine — "Your teacher is viewing your screen" — and a
  sticky "Your teacher viewed your screen at H:MM" stays until the student
  dismisses it (× on the strip; finding 8.1, built 2026-08-28) — the next
  peek re-shows it, so every peek is still disclosed.
  Non-blocking; the student keeps working. This is the "student-notified"
  contract from the plan, enforced client-side in the same code path that
  renders.
- **Render**: `window.contentView` via `cacheDisplay` (finding #14's exact
  call), downscaled to ≤1280 px wide, JPEG ~0.7 → roughly 100–250 KB.
  Main-thread render, encode off-main, then the existing fire-and-forget
  posture: a failed upload (`POST …/peek/upload`) logs and drops, never
  touches the attempt or an exit path.
- **Delivery + retention**: image lands in a `peek_requests` row (bytea) with
  `expires_at`; the monitor's existing 5 s poll surfaces "ready"; the teacher
  fetch DELETES the image on read, and a sweep kills anything older than
  ~60 s. Never S3, never the filesystem, never a log line. The row itself
  (who peeked whom, requested/delivered/viewed timestamps, no image) is kept
  as the audit record.
- **FERPA posture** (plan risk #4): 1:1, teacher-initiated, ephemeral,
  no archival — the image exists in one DB row for under a minute and its
  audit trail outlives it. Parent-notification language is a Phase 3
  item and does not gate this build, per the plan's phasing.

## What this is not (non-goals, MVP)

- No burst/stream/video — one still per click; the teacher clicks again.
- No thumbnail grid (finding #13 closed it).
- No mid-session `setConfiguration` changes, nothing AAC-facing at all — the
  session is untouched; this is pure app-level rendering.
- No student-side suppression: if the render fails the teacher sees
  "unavailable", never a stale image presented as current.

## Slices

| # | What | Verified by |
|---|---|---|
| P1 | `peek_requests` table + migration; `POST /api/attempts/:id/peek` (staff/owner), `GET .../peek` (student, own attempt), `POST .../peek/image` (student), `GET .../peek/image` (staff/owner, delete-on-read) + TTL sweep | DB tests: auth matrix (owner/other-staff/student/wrong-attempt), replace-on-re-request, delete-on-read, expiry |
| P2 | Client: peek poll while attempt open (Core-testable scheduling + state machine), banner + dismissable notice (8.1), `cacheDisplay` render + JPEG encode + fire-and-forget upload | `swift test` for poll/state/wire shape; render is AppKit, hand-run only |
| P3 | Monitor: Peek button on the student card, image modal, viewed-at recorded. Built 2026-08-28 — one deviation from this row as first written: the waiting card polls the collect endpoint itself (2.5 s, capped at 40 s) instead of riding the 5 s attendance poll, because the GET consumes the image (delete-on-read) and must be the one reader, fired only while a card is actually waiting. `attempt_id` added to the attendance payload for the button to post against | DB/UI tests where the suite reaches; hand-check in the browser |
| P4 | MANUAL-CHECKS rows: real-session peek end-to-end (locked Mac renders and uploads with full content — the finding-#14 claim on the shipping client), banner timing, delete-on-read observed in the DB. **RUN 2026-08-28 evening — all 7 rows ✅**; the locked cycle is stderr-proven between `DID BEGIN` and `DID END`. Follow-ups from the round in docs/phase-7-slices.md "Hand-run findings (2026-08-28 evening)" (8.1 dismissable notice, 8.2 resumed-attempt/monitor binding, 8.3 end-during-starting deferral) | Hand-run with the ACC2BG-style seed |

## Decisions (James, 2026-08-28)

- 6.1 Client poll cadence: **5 s** (matches the monitor; ~5–8 s
  teacher-click-to-image).
- 6.2 Peek allowed for **any in-progress attempt**, locked or not — an
  unlocked attempt after an emergency end is exactly when a teacher wants
  eyes on it.
- 6.3 **The `peek_requests` audit table alone is the record** — no
  `attempt_events` row.
- 6.4 Image retention: **delete on teacher read, 60 s TTL sweep** for the
  unread.
- 6.5 Rate limit: **10 s minimum between requests per attempt**, enforced
  server-side.
- 6.6 Banner wording approved: "Your teacher is viewing your screen" at
  request time; sticky "Your teacher viewed your screen at H:MM" for the
  rest of the attempt.
