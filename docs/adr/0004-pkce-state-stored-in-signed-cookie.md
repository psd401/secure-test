# 0004. Store PKCE in-flight state in a signed httpOnly cookie

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

The OIDC authorization-code + PKCE flow generates three short-lived secrets per login attempt:

- `code_verifier` — used at the token endpoint to prove ownership of the original `code_challenge`.
- `state` — opaque value echoed back by the IdP, verified at the callback to prevent CSRF.
- `nonce` — echoed in the id_token, verified at the callback to bind the response to this request.

Between `/api/auth/start` (issues the authorize redirect) and `/api/auth/callback` (receives the code), the design-tool needs to remember these values for the duration of one redirect round-trip — typically a few seconds, at most a few minutes. Options:

1. Server-side session store (Redis / DynamoDB / Postgres). Reliable, single-source-of-truth, but adds infrastructure.
2. Encrypted / signed cookie carrying the values. No additional infrastructure; bound to the same browser session by httpOnly + SameSite.
3. In-memory map keyed by `state`. Only works on a single-instance dev server; loses values on restart; doesn't scale to multiple Lambda invocations.

The design-tool has no backing data store today (Drizzle / Aurora is queued for a later slice). The PKCE state is itself bearer-secret material that only needs to survive ~minutes.

## Decision

Use option 2 — a short-lived (10-minute TTL), httpOnly, SameSite=lax cookie `secure-test-pkce` carrying `{verifier, state, nonce, next?}` as a signed JWT.

The signing key is `DESIGN_TOOL_PKCE_SECRET`, **separate from** `DESIGN_TOOL_SESSION_SECRET`. The two cookies have distinct issuers (`secure-test/design-tool/pkce` vs `secure-test/design-tool`) so a token minted for one purpose cannot be replayed for the other. The PKCE cookie is cleared at the end of the callback, whether the flow succeeded or failed.

## Consequences

- **Better**: zero new infrastructure; the entire flow works against any Lambda invocation without sticky sessions or a session store; the PKCE state is bound to the browser that initiated the login (the cookie won't be sent from a different browser).
- **Worse**: any HS256 secret leak compromises in-flight PKCE state. The 10-minute TTL and the SameSite=lax + httpOnly attributes mitigate this, but a server-side store would limit the blast radius further.
- **Escape hatch**: when a server-side data store lands (Slice 5+, with Drizzle/Aurora), `lib/auth/pkceCookie.ts` can be replaced by a `lib/auth/pkceStore.ts` that writes to the DB keyed by `state` and uses the cookie only as an opaque session ID. The callback route's interface (`verifier, state, nonce, next` retrieved by `state`) stays identical, so the swap is local.
