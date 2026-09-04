# 0017. Roster from the PSD warehouse, identity from Google — not ClassLink

- **Status**: Proposed (2026-08-26). Becomes Accepted when the warehouse
  confirmation under "Depends on" lands; the Google client and the AWS
  account were settled the same day.
- **Date**: 2026-08-26
- **Supersedes**: the ClassLink posture in ADR 0003 (the stub-exchange
  mechanism itself stays; the issuer changes).

## Context

Every sign-in and rostering decision in this repo assumed ClassLink: OIDC
LaunchPad for students and staff (PoC-C, ADR 0003, `lib/auth/roles.ts`), and
`classLink_sourcedId` as the bridge from an id_token to a roster row
(`lib/api/resolveStudent.ts`, migration 0012). All of it has waited since
2026-05-19 on a Partner Portal `client_id` that has not arrived, and on
2026-08-26 James said the org may not go that way at all.

What the org actually has, verified 2026-08-26:

- **AI Studio** (`psd401/aistudio`) signs students and staff in with **Google
  via Cognito**, not ClassLink, and joins its OneRoster mirror to users by
  lowercase email. Its ClassLink OneRoster sync Lambda (~4.2k lines) needs
  Partner Portal credentials in either auth mode, and its `oneroster_users`
  table carries no SSID.
- **The PSD data warehouse** (`psd_warehouse.ai_workspace` on Redshift, fed by
  MWAA DAGs, exposed to assistants through `psd-data-mcp`) already holds the
  PowerSchool roster: `students` (id, **email**, name, grade, school,
  `enroll_status`), `sections`, `section_enrollments` (`dateenrolled`,
  `dateleft`), `section_teachers` (`end_date`), `teachers` (**email**),
  `terms`, `schools`. PowerSchool is the system of record that ClassLink's
  OneRoster feed is itself derived from. What it lacks today is the state
  student id (SSID) that TIDE accommodations are keyed by; James confirmed
  adding it is quick.

Three options were weighed:

1. **Read AI Studio's `oneroster_*` tables.** Rejected — a hard runtime
   dependency on another product's private, fast-moving schema (migration 178
   and counting), a cross-VPC path ADR 0014 deliberately avoided, and no SSID.
2. **Port AI Studio's OneRoster Lambda**, sharing its Partner Portal key.
   Workable and proven, but it keeps ClassLink as a hop between PowerSchool and
   us, brings an OAuth1 protocol client and its paging/revision machinery, and
   whether OneRoster `users.identifier` carries the SSID for PSD is unknown
   until credentialed.
3. **Take a nightly extract from the warehouse.** The same data one hop
   closer to the source, in tables that exist to be queried, with the SSID a
   column-add away and no ClassLink credential anywhere in the path.

## Decision

**Roster: a nightly snapshot from the warehouse into secure-test's own
tables.** Preferred mechanism is a **push**: an MWAA DAG writes a versioned
extract (one file per table, plus a manifest with row counts and a checksum)
to an S3 prefix in secure-test's account; secure-test imports it into
`roster_*` tables with the same invariants AI Studio's sync enforces —
per-table transactions, absence-driven deactivation only after a complete,
non-empty, checksum-verified extract, last-known-good preserved on any
failure. A read-only Redshift credential is the fallback if a push is not
possible. The contract is the file schema, not the warehouse's tables.

**Identity: Google OIDC, PSD Workspace accounts.** Session identity is the
verified `email` (with `email_verified` and a server-side domain allowlist:
`psd401.net` → staff, `edtools.psd401.net` → student, anything else denied).
This replaces the `classLink_role` vocabulary in `lib/auth/roles.ts` and the
`classLink_sourcedId` bridge; the student is matched by lowercase email
against `roster_students`, scoped to a sitting whose owner teaches a section
that student is enrolled in.

**Cognito: our own user pool federated to Google — or none.** Sharing AI
Studio's pool is rejected: it lives in their account, and its app clients,
callback URLs and triggers are theirs to change. Whether to put a pool of our
own in front of Google at all is left open one slice longer: `/api/auth/
exchange` already verifies any issuer + JWKS (ADR 0003), so direct Google
OIDC from the client is close to a configuration change, and Cognito adds a
hosted-UI domain and a second token format for no capability we have named.
Either way the external dependency is identical — a Google Cloud OAuth client
that the Workspace admin trusts for student accounts (Workspace for Education
blocks unconfigured third-party apps for under-18 users by default).

**Accommodations stay keyed by SSID.** `students` stops being the roster and
becomes the per-teacher accommodations overlay it already is in practice,
joined to `roster_students` on SSID. TIDE import semantics are unchanged.

## Consequences

- **Better**: no ClassLink credential on the critical path; the one remaining
  external blocker of four months disappears rather than being unblocked. Sync
  is SQL/CSV-shaped, not an OAuth1 protocol client. Teachers' rosters derive
  from sections instead of being hand-maintained. Identity matches the org's
  other systems (AI Studio, psd-data-mcp both accept Google).
- **Worse**: a dependency on the warehouse pipeline (the data engineer's DAGs) and its
  schedule; a Google OAuth client to get trusted; PoC-C's ClassLink work and
  the `classlink_sourced_id` column are retired. If the warehouse is late one
  night, secure-test runs on yesterday's roster — acceptable by design.
- **Unchanged**: `DeliveryBundle` and the student plane; TIDE as the
  accommodations source; the `--token` dev posture until the client's
  sign-in slice lands.

## Depends on

1. The data engineer: SSID column on `ai_workspace.students` (PowerSchool
   `state_studentnumber`) and agreement on the push-to-S3 extract (or a
   read-only Redshift credential).
2. ~~Google Workspace admin: an OAuth client~~ **Settled 2026-08-26**: one
   of James's existing Google OAuth clients is used; the native client's
   redirect URI (and, if Cognito is used, the `idpresponse` URI) are added to
   it. Whether Workspace trusts it for *student* accounts is verified at the
   first student sign-in, not assumed.
3. **Settled 2026-08-26**: everything runs in James's AWS account
   (`<account-id>`, us-west-2) — the extract bucket, the importer, and the
   design tool per ADR 0014.

Slice plan: `docs/phase-6-slices.md`.
