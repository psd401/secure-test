# Monitor transport: SSE step-up — proposal (2026-08-31)

Status: PROPOSAL ONLY, parked for post-pilot. Written the night the first
Fargate deploy went in, because slice 86's transport decision
(`docs/phase-7-slices.md:239`) chose polling explicitly on the grounds
that "the app is not deployed yet" — that ground is gone once
the production origin is live. This doc records what SSE would take so
the decision can be made on cost/benefit, not archaeology.

## Today (slices 86/87, unchanged by the deploy)

- SittingsPanel attendance + MonitorView both poll
  `GET /api/test-sessions/:id/attendance` every 5 s (`LIVE_INTERVAL_MS`),
  visibility-aware, only while the sitting is open (or a student is still
  working). One small owner-scoped query per poll.
- Cost: one HTTP round-trip per teacher per 5 s per watched sitting.
  Pilot scale (a handful of teachers) ≈ noise. DB cost of SSE would be
  identical — the server still has to look, unless events get pushed at
  write time (below).

## What SSE buys / costs

Buys: sub-second updates (poll worst-case is 5 s + request time), fewer
requests, and a path to push-on-write (the attempt-events ingest already
knows the moment a student answers — a broadcast there makes the DB poll
unnecessary for the hot path).

Costs, all now measurable on the real stack:

1. **ALB idle timeout is 120 s** (set in slice 2 for long AI calls). An
   SSE response with no traffic for 120 s is cut — the stream must send
   a keepalive comment every ~30-60 s, and the client must auto-reconnect
   (EventSource does, with `Last-Event-ID`).
2. **One task today**: in-process pub/sub (an EventEmitter keyed by
   sitting id) works with desiredCount 1 and breaks silently at 2+ tasks
   — ALB round-robins the POST (event write) and the GET (stream) onto
   different tasks. Fine for the pilot; scaling out later needs a shared
   channel (Postgres LISTEN/NOTIFY is the no-new-infra option and Aurora
   supports it) — that choice can be deferred but must be WRITTEN DOWN in
   the route when built.
3. Next standalone route handlers stream fine (`ReadableStream`
   response); dev-mode buffering quirks are testable locally.
4. The client keeps polling as the fallback (Securly-style interceptors
   and school proxies sometimes mangle streams — the poll loop stays as
   the degraded path, same UI, so SSE is an enhancement, not a
   dependency).

## Sketch (when picked up)

- `GET /api/test-sessions/:id/events` — owner-gated SSE: initial
  attendance snapshot, then deltas on attempt-event ingest + join +
  submit; keepalive comment every 30 s; ends when the sitting closes.
- SittingsPanel/MonitorView: try EventSource, fall back to the existing
  5 s poll on error/close; LiveIndicator gains a "live (push)" state.
- No schema change; no new infra.

## Recommendation

Do nothing for the pilot — polling is proven, and 10.7-style network
weirdness argues for boring transports in week one. Revisit with real
numbers (CloudWatch request counts on /attendance) once teachers use
monitor in anger; build only if the 5 s latency or the request volume
actually bothers anyone.
