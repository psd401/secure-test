---
type: Subsystem Reference
title: Authentication, roles and the access ladder
description: Google OIDC sign-in, domain-derived staff/student roles, the HS256 session JWT (cookie or bearer), proxy.ts edge gating, and the view/run/edit/own access ladder with grants, admin and impersonation.
tags: [auth, oidc, authorization, access-control, security]
openwiki:
  roles: [architecture, domain]
  change_kinds: [security, lifecycle, public-api]
  source_paths:
    - design-tool/proxy.ts
    - design-tool/lib/auth/roles.ts
    - design-tool/lib/auth/identity.ts
    - design-tool/lib/auth/session.ts
    - design-tool/lib/auth/verifyIdToken.ts
    - design-tool/lib/api/requireSession.ts
    - design-tool/lib/api/access.ts
    - design-tool/lib/api/accessLevels.ts
    - design-tool/lib/api/grants.ts
    - design-tool/lib/auth/admin.ts
    - design-tool/lib/api/impersonation.ts
    - design-tool/app/api/auth/exchange/route.ts
  symbols: [roleForEmail, mapRole, sessionFromIdTokenClaims, requireStaff, requireStudent, requireStudentOrPractice, authorizeAssessment, authorizeSitting, authorizeAttempt, levelSatisfies, loadActiveGrants, effectiveLevel, isAdmin, isImpersonating]
  test_paths:
    - design-tool/test/auth-roles.test.ts
    - design-tool/test/auth-identity.test.ts
    - design-tool/test/auth-role-enforcement.test.ts
    - design-tool/test/auth-bearer.test.ts
    - design-tool/test/auth-exchange-route.test.ts
    - design-tool/test/oauth-flow.test.ts
    - design-tool/test/access-enforcement.test.ts
    - design-tool/test/access-grants.test.ts
    - design-tool/test/grants-api.test.ts
    - design-tool/test/impersonation-api.test.ts
  invariants:
    - Role is derived from the verified email domain at login and read back from the signed session; no token role claim is trusted.
    - Every cross-owner refusal on an authorize* helper is a 404, never a 403.
    - A grant only counts while revoked_at is null, starts_at <= now and ends_at is null or in the future; school-scope grants are stored but never resolved.
  validation_commands: ["cd design-tool && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test test/access-enforcement.test.ts test/auth-roles.test.ts"]
---

# Authentication, roles and the access ladder

Consult this page when touching sign-in, any `requireX` guard, ownership checks on a route, sharing/co-teaching, admin or "act as" features. Student-plane identity (matching a login to a roster row) is a separate step documented in [sittings and attempts](sittings-and-attempts.md) and [accommodations and roster](accommodations-and-roster.md).

## Sign-in (ADR 0017: Google Workspace, not ClassLink)

Two entrances mint the **same** session JWT:

| Entrance | Route | Used by |
| --- | --- | --- |
| Browser OIDC + PKCE | `GET /api/auth/start` → IdP → `GET /api/auth/callback` | teachers on the web (PKCE state lives in a signed `secure-test-pkce` cookie, ADR 0004; `lib/auth/pkce*.ts`, `safeNext.ts` guards `?next=`) |
| Token exchange | `POST /api/auth/exchange` (body `id_token`) | the macOS client, which runs its own Google PKCE flow (`GoogleSignIn.swift`) and sends the id_token; response includes `session_token` and sets the cookie |

Both end in `sessionFromIdTokenClaims` (`lib/auth/identity.ts`): requires `sub`, lowercases `email`, requires `email_verified`, then calls `roleForEmail` (`lib/auth/roles.ts`). `STAFF_DOMAINS = ["psd401.net"]`, `STUDENT_DOMAINS = ["edtools.psd401.net"]`; anything else → `account_not_allowed` and no session. `emailDomain` rejects multi-`@` strings to block allow-list smuggling. Token verification (`verifyIdToken.ts`) requires an explicit audience (`resolveExpectedAudience`: `OIDC_AUDIENCE` or `OIDC_CLIENT_ID`, comma-separated so both web and native client ids work).

The `ALLOW_TEST_ISSUER=1` escape hatch on `/api/auth/exchange` (caller names its own issuer+JWKS) is server-only, ignored when `NODE_ENV=production`, and the route returns 500 if both are set — never weaken this.

**Session**: HS256 JWT, issuer `secure-test/design-tool`, 8-hour TTL, signed with `DESIGN_TOOL_SESSION_SECRET` (`lib/auth/session.ts`). Payload: `sub`, `role`, `email`, `hd`, and (impersonation only) `actor_sub`/`actor_email`. Cookie `secure-test-session` (httpOnly, lax, secure in production) for the web; `Authorization: Bearer` for the native client. `readSession()` in `lib/api/requireSession.ts` checks bearer first and does **not** fall through to the cookie when a bearer is present but invalid.

## Guards

- `proxy.ts` (edge): every request gets an `x-request-id`; `/dashboard*` and `/admin*` additionally require a valid session whose role is staff — a student session is redirected to `/login?error=student_account`, no session to `/login?next=…`. Missing `DESIGN_TOOL_SESSION_SECRET` renders a hand-written 500 page (`misconfiguredPage`). API routes are **not** protected by the proxy; each route calls a guard itself.
- `requireStaff()` (teacher surfaces), `requireStudent()`, `requireStudentOrPractice()` (student plane; also admits staff, who can only ever reach a *practice* sitting naming themselves — see [sittings](sittings-and-attempts.md)), `requireSession()` (any principal; avoid). Wrong role → 403; no/invalid session → 401.
- `mapRole` accepts only the exact strings `staff` / `student`; pre-slice-77 sessions carrying ClassLink titles are denied and must sign in again.

## The access ladder (docs/access-model-design.md)

`AccessLevel = view < run < edit < own` (`lib/api/accessLevels.ts`, re-exported from `lib/api/access.ts`; the split avoids an import cycle with `grants.ts`):

| Level | Allows |
| --- | --- |
| `view` | results and monitor, read-only |
| `run` | sittings, monitor actions, hand in, extend |
| `edit` | items, settings, publish, scoring |
| `own` | share, archive, delete, grant |

`authorizeAssessment(db, session, id, need)`, `authorizeSitting`, `authorizeAttempt` (sitting/attempt authorize **through their assessment**; `test_sessions.owner_sub` is provenance, not permission), plus student/rubric/asset variants that resolve only owner or admin (per-teacher tables are not reachable via assessment grants). Resolution order in `grants.effectiveLevel`: owner → `own`; admin → `own` via `"admin"`; else the highest live grant. Each success carries `via: owner | grant | admin` and the grant `scope`. All refusals are `404 not_found` (and malformed ids `400 invalid_id`) so ids cannot be probed.

Grants (`access_grants`, `lib/api/grants.ts`, routes under `/api/assessments/[id]/grants`, `/api/grants`): keyed on **email** (a substitute may not have signed in yet), scopes `assessment` (by id) and `teacher` (by the assessment owner's email, via denormalised `assessments.owner_email`; an assessment with NULL `owner_email` resolves no teacher-scope grant) and `school` (stored, inert — pinned by a test). `loadActiveGrants` is one query per request; `grantedLevel` is pure so list pages (`visibleAssessments.ts`) resolve fifty rows with one query. A `teacher`-scoped grant means substitute: sittings they start stay the granting teacher's (`created_by_sub` records the sub).

Other sharing models: `assessment_shares` (`lib/api/shares.ts`) is **copy semantics** — the recipient accepts and gets an independent import of a lossless export; no access is shared afterward. `lib/roster/coTeachers.ts` (`coTeachersOf`) only *suggests* co-teachers from current roster sections (read-only) — the Share dialog's Co-teach mode decides whether to write an `access_grants` row. The admin-only grant surface is `/api/grants` (returns 404 to non-admins so its existence is not leaked).

**Admin** is a config list, not a role: `ADMIN_EMAILS` (comma list, `lib/auth/admin.ts`). It widens only the *ownership* check (admin → `own` everywhere), never the role check. **Impersonation** (`POST /api/admin/impersonate[/stop]`, `lib/api/impersonation.ts`, `impersonation_sessions` audit table): mints a session whose `sub/email/role` are the target teacher's with `actor_sub` set; `isAdmin()` is false while `actor_sub` is set, so act-as cannot reach admin pages or chain. A target can only be a staff address that owns an `assessments`/`test_sessions` row.

## Change recipes

- **New teacher route**: call `requireStaff()`, then `authorizeAssessment(db, session, id, level)` with the *lowest* level that fits the table above; return its `response` unchanged. Never compare `owner_sub` inline.
- **New student route**: `requireStudentOrPractice()` → `loadOwnAttempt` (404 on mismatch); add the closed-sitting and deadline guards if it writes ([sittings](sittings-and-attempts.md)).
- **New access level or scope**: touch `accessLevels.ts`, `grants.ts` (`RESOLVED_SCOPES`), the `access_grants` CHECK constraints in `db/schema.ts` + a migration, and `visibleAssessments.ts`; add a stored-but-inert test if the arm is not live.
- **New allowed email domain**: `STAFF_DOMAINS`/`STUDENT_DOMAINS` only; update `auth-roles.test.ts`.

## Escalate / don't do

- Do not read `.env*` for secrets; the required env names are `DATABASE_URL`, `DESIGN_TOOL_SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` (+ optional `DESIGN_TOOL_PKCE_SECRET`, `DESIGN_TOOL_DELIVERY_SECRET`, `OIDC_CLIENT_SECRET`, `OIDC_AUDIENCE`, `ADMIN_EMAILS`).
- Role or ownership model changes warrant the broader `access-enforcement` and `auth-role-enforcement` suites, not just unit tests.

Related: [data model](data-model.md) (`access_grants`, `impersonation_sessions`), [architecture overview](../architecture/overview.md), [deployment](../operations/deployment-and-observability.md) for secrets in ECS.
