# 0003. Stub the auth exchange route before the full ClassLink flow

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

The design tool needs ClassLink OIDC for staff login (same code path PoC-C verified server-side). The full browser flow requires: login button → authorize redirect → callback handler → code-for-token exchange → id_token verification → session JWT mint → cookie. PoC-C's client-side Partner Portal app registration is still pending approval, so the end-to-end flow can't be tested against ClassLink staging.

What CAN be built and tested today: the verify-id-token-and-mint-session piece, exercised with a hand-signed token against a local JWKS.

## Decision

Slice 2 ships only the **back half** of the auth flow:

- `POST /api/auth/exchange` accepts a body `{ id_token, test_issuer?, test_jwks? }`.
- It verifies the id_token against either the configured `OIDC_ISSUER` (production) or a per-request `test_issuer` + `test_jwks` (only when `NEXT_PUBLIC_ALLOW_TEST_ISSUER=1`).
- It mints an HS256 session JWT with `sub`, `role`, `classLink_sourcedId` claims and sets a `secure-test-session` httpOnly cookie.

The browser-facing front half (login button → redirect → callback → code exchange) is deferred to a later slice, once the Partner Portal app is approved.

## Consequences

- **Better**: we can develop and unit-test the entire session lifecycle locally without depending on ClassLink. Once the redirect flow lands, it slots in front of an already-tested mint step. The verification logic reuses PoC-C's `jose` + JWKS pattern.
- **Worse**: the test-issuer escape hatch is a footgun if it ever leaks into production. It's gated by `NEXT_PUBLIC_ALLOW_TEST_ISSUER=1` and must stay off in any deployed environment.
- **Escape hatch**: when the redirect flow lands, the `test_issuer` / `test_jwks` fields and the `NEXT_PUBLIC_ALLOW_TEST_ISSUER` gate go away entirely (or move behind a server-only dev-mode check).

## Update — 2026-08-14 (Phase 1–2 review, finding A5/A2)

The "move behind a server-only dev-mode check" option above was taken. The gate is
now the server-only `ALLOW_TEST_ISSUER` (a `NEXT_PUBLIC_*` var ships to the client
bundle and is easy to leak into a deployed build), and `/api/auth/exchange` hard-fails
whenever `NODE_ENV=production` regardless of how that var is set. The route also no
longer passes `audience: undefined` to jose — audience now resolves through
`resolveExpectedAudience()` (`OIDC_AUDIENCE || OIDC_CLIENT_ID`) and the route 500s if
neither is configured, so a token minted for a different client at the same issuer can
no longer mint a session. The `test_issuer` / `test_jwks` fields still exist; removing
them stays deferred to ClassLink go-live.
