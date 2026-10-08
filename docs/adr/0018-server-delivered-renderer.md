# 0018. Serve the test page's renderer from the server; keep the native shell signed

- **Status**: Proposed
- **Date**: 2026-10-08

## Context

The student client's page code (item rendering, styles, the instant
feedback page) is compiled into the signed app as Swift string literals.
Every change a student sees therefore needs a signed release, IT's
AutoPkg run (next-day delivery) and, for a new item type, a delivery
version gate. Most recent releases were mainly page code. The page is a
no-origin document whose CSP blocks every fetch; data leaves only through
8 named message handlers. Today a compromised server can change test
content, but not the code running inside the locked session.

## Decision

The design tool builds and serves the renderer. The native shell fetches
it before `AEAssessmentSession.begin()`, verifies it, and inlines it into
the same no-origin, fetch-blocking page. Lockdown, sign-in, exits, the
spool, uploads, speech, the countdown and the bridge stay in the signed
app. Every message handler treats its payload as untrusted input. Every
renderer change runs on a staging stack with a real client before
production. The renderer is a separate versioned file pinned by hash in
the delivery bundle, cached on the Mac and re-verified on every use, and
it carries a detached signature made with a key the server never holds,
checked against public keys compiled into the app, with a minimum version
against replay. Key storage and the compatibility contract are open in
`docs/server-delivered-renderer-design.md`.

## Consequences

- Easier: page fixes and new item types ship with a design-tool deploy;
  version gates are needed only for shell changes.
- Harder: whoever holds the signing key now decides what code runs
  inside lockdown, and the bridge's validation becomes the security
  boundary. Signing narrows the server's role: a compromised server can
  change content (as today) but not run code inside lockdown. It does not
  protect against a compromised repository or GitHub account — the signer
  signs whatever is on `main`. A bad deploy reaches every Mac within
  minutes instead of over a day, so staging becomes mandatory. The server
  must keep serving renderer versions still in use by tests in progress.
- Escape hatch: the v2.0 shell can keep a bundled renderer behind a
  launch flag, and a later release can return to it if served renderers
  prove unsafe or unreliable.
