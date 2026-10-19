# secure-test — Claude project notes

PSD macOS secure-testing browser + teacher-facing assessment-authoring "design-tool" that feeds it. Bun workspace monorepo.

## Layout
- `design-tool/` — Next.js 16 web app (teacher-facing authoring + the student plane API). Drizzle + Postgres, Zod, KaTeX, Google OIDC+PKCE (ADR 0017).
- `client/` — the macOS student client (Phase 5). `SecureTestCore/` is a SwiftPM package holding all the logic so it is testable headlessly; `SecureTest.xcodeproj` is the AppKit app. Supersedes `poc-b-test-loop/client`. See `client/README.md`.
- `packages/` — shared code (Zod schemas, etc.).
- `poc-*/` — proof-of-concept clients (AAC capture, test loop, ClassLink SSO — the last one historical since ADR 0017). Kept as the empirical record; PoC-A is still the spike for the ScreenCaptureKit-inside-AAC question.

## Dev (run the app from `design-tool/`, not repo root)
- `bun install` at root (workspace).
- `cd design-tool && bun run dev` — the dev server runs from `design-tool/`. Running it from the repo root is a recurring mistake.
- Copy `design-tool/.env.local.example` → `.env.local` and fill it before `dev`; unset OIDC/env vars are a common startup failure.
- Next 16 uses `proxy.ts` (renamed from `middleware`); a missing export there breaks dev.
- DB: `bun run db:generate` / `bun run db:migrate` (Drizzle). Tests: `bun test`. Typecheck: `bun run typecheck`.
- DB tests need the test database explicitly: `DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test`.

## Dev (the client, from `client/`)
- `cd client/SecureTestCore && swift test` — all the logic. No Xcode, no window server.
- `cd client && xcodebuild -project SecureTest.xcodeproj -scheme SecureTest -destination 'platform=macOS' build`.
- The AppKit/WebKit surface (drag, Touch Bar, menus, file pickers) CANNOT be tested here — no window server, and headless browsers hang (ADR 0013). `client/MANUAL-CHECKS.md` is the hand-check list; keep it current when hardening changes.

## Workflow & conventions
- One slice at a time, commit per slice, wait for explicit "proceed" / push approval.
- AI model wiring is live: Claude Sonnet 4.6 (item gen) + Haiku 4.5 (math) on Amazon Bedrock via SigV4 (ADRs 0007/0011); `mock` stays the default for tests/CI. S3 storage is live (ADR 0008), including presigned client uploads; local-fs remains the dev default. Identity is **Google OIDC** (ADR 0017, slices 77–81): role from the verified email domain (`psd401.net` staff, `edtools.psd401.net` student), `OIDC_AUDIENCE` lists the web and native client ids, the client signs in through `ASWebAuthenticationSession` (`SECURE_TEST_GOOGLE_CLIENT_ID`) and keeps `--token` / `SECURE_TEST_TOKEN` for dev/CI. Roster is a nightly warehouse extract into `roster_*` (`docs/roster-extract.md` is the data engineer's contract; `lib/roster/`); `students` is the per-teacher accommodations overlay joined on `roster_ps_id` / SSID. Nothing ClassLink remains in code. Mark remaining deferred wiring as "TODO" in docs.
- Two wire formats, deliberately (ADR 0016): `ItemBundleSchema` is the teacher's export and CARRIES the answer keys (import round-trips through it); `DeliveryBundleSchema` is the student's and has no field that can hold one. Never merge them. Match/order additionally carry per-attempt sealed option ids, because their key is carried by structure rather than by a field.
- Accommodations source of truth: TIDE import is canonical per-bundle (re-import overwrites); teachers may then edit (IEPs change); manual entry also allowed.
- **AAC hard rule:** anything that calls `AEAssessmentSession.begin()` ships an exit path in the same change (PoC-A's first session needed a forced shutdown). A real AAC session breaks DNS for every OTHER process on the Mac until `DID END` (finding 10.7) — including Claude's own connection, so James drives real-session rows and Claude does the teacher side between sessions.

## Current state and history
- **History lives in `docs/ledger.md`** (the dated status entries that used to be here, moved 2026-10-19 because this file had grown past 200 KB). Read its newest "STATE AT CLOSE-OUT" / dated entries before starting work; add new entries THERE, not here.
- Detailed records: `docs/roadmap-2026-09.md` (§Progress), the design notes in `docs/`, `docs/design-tool-manual-checks.md`, `client/MANUAL-CHECKS.md`, `client/RELEASING.md`.
- As of 2026-10-18: production is HELD at `3e1ecc58` until v2.0 ships; `main` carries undeployed work incl. migrations 0060 + 0061 (deploy after 15:30 PT on a weekday or with `--during-school`); v2.0 waits on IT's signed rehearsal manifest. Check `docs/ledger.md` for anything newer.

## Key working rules
- Deploy = `design-tool/infra/scripts/deploy.sh` (James runs it if the classifier denies it); the container migrates at boot; read the `health stamp` line, not the exit code. `colima start` first.
- `packages/schema` is consumed through `dist` — `bun run build` there after editing `src`. `cd client && bun scripts/vendor-katex.mjs` after a katex bump or `macros.ts` edit.
- If `bun run dev` shows more than a handful of `postcss.js` processes, stop and `bun run dev:clean`.
- Never edit or stage in this checkout while another Claude terminal is active in it — use a worktree. The OpenWiki bot pushes after every push to `main` — rebase before pushing.
- Never grep or read `.env.local`. Write classifier-blocked scripts to the scratchpad and hand them to James (`! bash <path>`).
- More rules, by date, in `docs/ledger.md` ("Working rules learned").

## Naming (James, 2026-10-09)

- **Product name = `SecureTest`** in everything a person reads: UI, emails,
  help / roadmap pages, release notes, living docs. Code takes it from ONE
  constant per side — `design-tool/lib/brand.ts` (`PRODUCT_NAME`) and the
  client's `Brand.productName` + the Xcode `PRODUCT_DISPLAY_NAME` build
  setting. A drift test refuses a hand-typed `Secure Test` / `Secure-Test`.
- **Identifiers keep their per-language forms and are NEVER renamed for a
  brand change:** `secure-test` (repo, URLs, packages, cookies, issuers, infra
  names), `SecureTest` (Swift, Xcode, `SecureTest.app`, pkg, HTTP header),
  `securetest` (reverse-DNS: bundle id, managed-preferences domain). The
  bundle id, prefs domain, app / pkg names and IT's AutoPkg recipe and Jamf
  profile depend on them.
- Dated records (design notes, hand-run checks, this file's ledger) keep the
  name they were written with. `docs/roadmap-2026-09.md` row NM is the record.

## Contributing / what stays out of this repo

This repository is public. `docs/public-release-plan.md` is the record of
the sweep that made it so; the rules below are what keeps it that way
going forward (its slice 5).

- **No account ids, ARNs, hostnames, client ids, emails or personal names
  in tracked files.** Use roles ("the data engineer", "the IT director",
  "a teacher") and placeholders (`<account-id>`, `<origin>`,
  `<your-sso-profile>`, `<TEAM_ID>`) instead. The maintainer's name is the
  one exception — it stays as author/maintainer in ADRs and this file's
  README-equivalent framing; his email and AWS SSO profile name are
  scrubbed like everyone else's.
- **Student data never.** No real student name, number, SSID or email
  goes into a tracked file, commit message, or test fixture — not even
  temporarily. The three demo accounts used in hand-runs appear only as
  `<demo-student-A>` / `-B` / `-C` placeholders (their values live in the
  ops repository) — no student-shaped identifier is tracked. `git grep` for
  the patterns below before every commit that touches a student-facing
  doc or fixture.
- **Teacher-authored content never.** No verbatim quote, table, or
  figure description from a real teacher's assessment goes into a doc —
  design pages and hand-run records use hand-built fixtures (see
  `design-tool/test/helpers/pdf.ts`) or paraphrase instead. A finding
  about the importer's behavior on real content can still be recorded;
  the content itself can't be quoted.
- **District infrastructure specifics go to the ops repository**, not
  here: IT/vendor request drafts that name people and dates, real
  staff/section data, day-of hand-run scripts. That repo is private and
  referenced here only as "(internal — see the ops repository)", never
  by path.
- **Infra config lives in context, not source.** `design-tool/infra/`'s
  account id, OAuth client ids, MWAA role ARN, Bedrock guardrail id and public `domainName` are
  read from `cdk.context.json` (gitignored) via CDK context, never
  hardcoded — see `design-tool/infra/cdk.context.json.example` and that
  directory's README. `DesignToolStack` throws a clear error at
  synth/deploy time if `domainName` is missing rather than falling back
  to a real hostname.
- **The pre-commit scanner blocks what it can; review catches the
  rest.** `.gitleaks.toml` at the repo root extends the default gitleaks
  ruleset with rules for student-domain addresses, SSID-shaped numbers
  near roster field names, digit runs in markdown, AWS account ids near
  AWS-shaped context, and Google OAuth client ids. Run it on the staged
  changes before committing anything that might carry one of the patterns
  above: `gitleaks git --pre-commit --staged --config .gitleaks.toml`
  (a directory scan, `gitleaks dir . --config .gitleaks.toml`, also reads
  gitignored files such as `.env.local` and build output, so expect hits
  there that never reach a commit). The hook (`.githooks/pre-commit`)
  also runs the identifier sweep from `.github/identifier-sweep.txt` —
  hostname, account ids, egress range and the like — over the lines a
  commit adds; `scan.yml` runs the same file over every tracked file.
  Neither is
  a substitute for review — a hostname or a person's name is
  identifier-shaped, not credential-shaped, so gitleaks' default rules
  (and most of the added ones) cannot catch a new one on their own; the
  patterns in this section are what a human reviewer checks for.

