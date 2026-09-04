# Phase 6 — identity and roster without ClassLink

Proposed 2026-08-26 under ADR 0017. Same shape as `docs/phase-5-slices.md`.
Design-tool numbering (Phase 6 follows the client's Phase 5); `docs/plan.md`'s
own phase numbers are unrelated — reconciling them is still open.

**Built 2026-08-26, slices 74–81, one commit each, not pushed.** The table
under "Slices" is the plan as approved; "What it produced" is what landed.

## What it produced

| # | Commit | What | Verified here | Hand-check / waits on |
|---|---|---|---|---|
| 74 | `840c35f` | ADR 0017 + this plan | — | — |
| 75 | `bf3668a` | `roster_*` tables (migration 0018), extract contract (`lib/roster/extract.ts`), importer, fixtures, `docs/roster-extract.md` | 17 pure + 9 DB tests: complete / partial / empty / checksum / count / bad row / duplicate / dangling ref / idempotent re-run / deactivate + reactivate | the data engineer: SSID column, push vs pull, cadence |
| 76 | `b4acf66` | S3 bucket + put-only producer policy + importer Lambda in CDK; `mock` source default; `scripts/roster-import-local.ts` | `cdk synth` exit 0 (36 resources, 10 RosterSync); 12 handler tests; manual local run: complete → 0, partial → 1, misuse → 2 | Deployed 2026-08-26 evening (additive diff only). The data engineer's principal gets the producer policy; Aurora migrations pending |
| 77 | `007d0d7` | Google issuer; role from verified email domain; `OIDC_AUDIENCE` list; Google `iss` alias; both routes share `lib/auth/identity.ts`; **no Cognito pool** (no blocker needed one) | 12 roles + 10 identity + 9 exchange-route tests; 23 suites re-pointed | Live sign-in needs James's web client id + secret and `/api/auth/callback` as a redirect URI. `.env.local.example` not editable from this session — README carries it |
| 78 | `8f0d05f` | Resolve by email → roster; sitting scope by section / explicit list; `students` overlay bound on `roster_ps_id` / SSID (migration 0019); redeem oracle collapse extended to `not_in_sitting` | 21 resolver tests; 5 student-plane suites re-pointed | — |
| 79 | `271434f` | `/dashboard/accommodations` from sections; `GET /api/roster/sections`; `section_ps_id` / `student_ps_ids` on `POST /api/test-sessions` (narrowing only) | 16 query-layer + 8 sitting-scope tests | The page's rendering (no window server) |
| 80 | `793d09f` | Client: PKCE + `GoogleSignInFlow` in Core, `ASWebAuthenticationSession` presenter, sign-in button, `exchangeIdToken`, MANUAL-CHECKS rows | `swift test` 163 → 184; `xcodebuild` succeeds | The sheet: 11 MANUAL-CHECKS rows, all unverified; needs the native client id |
| 81 | see `git log` | `classlink_sourced_id` dropped (migration 0020 — column held 0 values in both local DBs; only a ClassLink login could ever have written it), `classLink_*` claims gone, PoC-C + checklist section historical, CLAUDE.md / plan.md #2 + 6.17 / READMEs updated | typecheck clean; DB suite 853 pass, 0 fail; `swift test` 184, 0 failures | — |

Design-tool DB suite: 752 → 853 pass across the phase (47 → 53 files);
non-DB run has the expected DB-only failures and nothing else.

### Still waits on

- **the data engineer** — replied 2026-08-27 (internal — see the ops repository): S3 push from the DAG, SSID = `state_studentnumber`, 6:00 AM PT daily. Our side closed in phase-7 slices 88–90; now waiting on the first snapshot. *Original:* (3.2) `state_studentnumber` as `ssid` on `ai_workspace.students`;
  (3.1) the MWAA push to `s3://secure-test-roster-<env>/roster/<snapshot_id>/`
  per `docs/roster-extract.md`, or a read-only Redshift role and we pull; the
  cadence. Until then the roster is the fixture, the bucket is unsynthesised
  into any account, and `students.ssid` stays nullable.
- **James's Google client** — the web client id + secret (callback
  `<origin>/api/auth/callback`) for the dashboard, and an iOS/macOS-type
  client id for the native app (redirect = reverse client id). Both go in
  `OIDC_AUDIENCE`. Then: the first staff sign-in, then the first
  `edtools.psd401.net` student sign-in, which is the only way to learn whether
  Workspace trusts the client for under-18 accounts (ADR 0017 "Depends on" #2)
  and what `hd` says for the student domain (slice 77 logs the disagreement).
- ~~**Deploy** of the slice-76 stack~~ — deployed 2026-08-26 evening
  (`secure-test-roster-dev`, producer policy, `secure-test-roster-sync-dev`);
  the request to the data engineer is internal (see the ops repository).
  Migrations 0018–0020 are applied on all three databases — test, Aurora and
  local dev (2026-08-26 evening; the Aurora procedure is "Migrating Aurora"
  in `infra/README.md`). Nothing on our side stands between the data engineer's first
  push and an import.

### Decided along the way (not in the plan text)

- A sitting's scope only NARROWS "all my sections" — listed students must be
  in the owner's sections. Widening (coaches, admins) is 3.6, still open.
- Without a sitting in hand (delivery, attempt routes), resolution finds or
  binds an overlay row but never creates one, so a probe leaves nothing on a
  teacher's accommodations page.
- `roster_students.email` is indexed, not unique: a warehouse duplicate must
  not block a night's sync; the resolver refuses the ambiguity instead.
- `is_active` means "the warehouse still reports it"; whether a relationship
  holds today is a date check in `lib/roster/queries.ts`, using Postgres'
  `current_date`.

## Goal

A student signs into the client with their PSD Google account, joins a
sitting, and is resolved to a roster row that came from the warehouse — with
no ClassLink credential anywhere. A teacher's roster is the sections they
teach. Accommodations still key on SSID.

## Groups

- **A — roster snapshot** (74–76): tables, importer, sync entrypoint.
- **B — identity** (77–78): Google issuer, domain roles, email resolution.
- **C — surfaces** (79–80): teacher roster from sections; client sign-in.
- **D — retirement** (81): remove the ClassLink paths.

A and B are independent and can be approved in either order. C needs both.

## Slices

| # | What | Verifies |
|---|---|---|
| 74 | ADR 0017 + this plan | — |
| 75 | **Roster tables + importer.** Drizzle migration: `roster_students` (ps_id, ssid, email, first/last, grade, school_id, enroll_status, is_active), `roster_sections`, `roster_section_teachers` (teacher_email, end_date), `roster_enrollments` (student, section, dateenrolled, dateleft, is_active), `roster_sync_runs`. `lib/roster/importSnapshot.ts` takes a manifest + files, verifies counts and checksum, upserts per table in one transaction each, deactivates absent rows only on a complete non-empty extract, refuses partial/empty (last-known-good preserved). Manifest carries per-file row counts + sha256. Fixtures under `design-tool/test/fixtures/roster/`. Publish the file/manifest contract as `docs/roster-extract.md` — that is what the data engineer receives. | `bun test`: complete / partial / empty / checksum-mismatch / re-run idempotent |
| 76 | **Sync entrypoint.** S3-drop trigger in `design-tool/infra` (S3 event → Lambda or scheduled task) calling the importer; `mock` file source is the test default. Bucket in James's account (`<account-id>`, us-west-2). Structured log with counts only, no PII. Not deployed in this phase; `bunx cdk synth` must pass. | `bun test` on the handler with a mocked bucket; one manual run against a hand-made extract |
| 77 | **Google issuer.** `OIDC_ISSUER=https://accounts.google.com` path through `app/api/auth/{start,callback,exchange}` (discovery already generic per ADR 0003). Session claims become `email`, `email_verified`, `hd`. `lib/auth/roles.ts` maps by domain allowlist — `psd401.net` staff, `edtools.psd401.net` student, else denied — replacing the ClassLink vocabulary. `ALLOW_TEST_ISSUER` gate unchanged; build and test against it first. Try direct Google OIDC before any Cognito pool; add a pool only for a concrete blocker, named in the commit. Ask James for the real client id / redirect URI when a live check needs it, and keep working meanwhile. | Existing auth tests re-pointed; new tests for each domain outcome and for `email_verified=false` → denied |
| 78 | **Resolve by email.** `lib/api/resolveStudent.ts` matches `lower(email)` against active `roster_students`; the sitting is joinable only if its assessment owner (`teacher_email`) has an active `roster_section_teachers` row on a section the student has an active enrollment in, or the sitting carries an explicit student list. `students` (accommodations) joins on SSID; `/api/test-sessions/redeem` unchanged in shape; oracle-collapse from the Phase 5 review preserved (`d7ab41e`). | `bun test`: on-roster / wrong-teacher / inactive enrollment / no-email; DB tests against the test database |
| 79 | **Teacher roster from sections.** `/dashboard/accommodations` roster reads "my sections → students" from `roster_*`; manual and TIDE rows remain the accommodations overlay (the source-of-truth rule in CLAUDE.md is unchanged). Sitting creation offers "all my sections" or a picked section. | `bun test` on the query layer; hand-check the page |
| 80 | **Client sign-in.** `ASWebAuthenticationSession` Google PKCE flow ported from PoC-C's structure (`poc-c-classlink-sso/client`), id_token → `/api/auth/exchange` → session JWT → Keychain (`KeychainTokenStore`). `--token` / `SECURE_TEST_TOKEN` retained for dev and CI. | `swift test` on the PKCE/state helpers; `MANUAL-CHECKS.md` rows for the browser round-trip — it cannot be verified here (ADR 0013); say so |
| 81 | **Retire ClassLink.** Drop `students.classlink_sourced_id` (migration), `classLink_*` claim handling, `roles.ts` vocabulary; PoC-C and `docs/unblock-checklist.md`'s ClassLink section marked historical; `client/README.md`, `CLAUDE.md`, `docs/plan.md` risk #2 and 6.17 updated. | `bun run typecheck`; all suites green |

## Execution rules (for a `/goal` run)

- Order 75 → 81, one commit per slice, detailed message, no self-attribution.
  Never push.
- Verify every slice: `cd design-tool && bun test` (DB slices also with
  `DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test
  bun test`) and `bun run typecheck`; `cd client/SecureTestCore && swift test`
  for 80–81; `cd design-tool/infra && bunx cdk synth` for 76. Report counts,
  not adjectives. Anything only a window server or a live IdP can verify goes
  in `client/MANUAL-CHECKS.md` and is listed as unverified.
- Guardrails: bun, never npm. Fixtures only — no live student data. `mock`
  stays the test/CI default. Do not touch `DeliveryBundleSchema` /
  `ItemBundleSchema` (ADR 0016). No `AEAssessmentSession` work — separate
  track. No time estimates. Simple and working beats clever.
- Stop and report when: a slice needs the data engineer (SSID source, extract cadence) to
  proceed rather than to be designed around; a Google/Cognito blocker changes
  ADR 0017's decision; a migration would destroy data; a test would depend on
  a live service.
- Final report: per slice — commit hash, files, test counts before/after,
  verified vs hand-check-only; then what still waits on the data engineer and on the
  Google client, and whether ADR 0017 should move to Accepted.

## Decisions carried in from ADR 0017

- Push extract preferred over pulling from Redshift; the file manifest is the
  contract.
- Absence deactivates; nothing is ever hard-deleted by sync.
- Role is derived from the email domain, never from a client-supplied claim.
- Cognito in front of Google is decided in slice 77, by evidence: if direct
  Google OIDC works end to end with `exchange`, no pool.

## Unresolved

- 3.1 Extract cadence + mechanism — S3 push from MWAA, or Redshift read role? (the data engineer)
- 3.2 SSID column name/source in `ai_workspace.students` — PS `state_studentnumber`? (the data engineer)
- ~~3.3 Google OAuth client~~ — one of James's existing clients (2026-08-26). Student-account trust checked at first student sign-in.
- ~~3.4 Cognito pool or direct Google~~ — direct Google; decided in 77 by building it (no blocker needed a pool).
- ~~3.5 Sittings: section-scoped by default, or keep code-only join for ad-hoc?~~ Both (2026-08-27): scoped sittings surfaced to the student are the default path, the code stays for ad hoc — `docs/phase-7-slices.md`.
- 3.6 Staff who aren't teachers of record (coaches, admins) — sitting ownership rule?
- ~~3.7 AWS account~~ — James's (`<account-id>`, us-west-2) (2026-08-26).
