# @secure-test/design-tool

Next.js 16 web app for teachers to author, distribute, and review assessments delivered by the secure-test macOS client.

## Current state (through Slice 34)

- Next.js 16 + React 19 + Tailwind 4 (CSS-first) + shadcn-compatible aliases. Consumes `@secure-test/schema` via the bun workspace.
- Full OIDC + PKCE login flow against any conformant IdP — **Google** (`OIDC_ISSUER=https://accounts.google.com`, PSD Workspace accounts) in production per ADR 0017, a bundled mock issuer for local testing. The principal role is derived server-side from the verified email domain (`psd401.net` → staff, `edtools.psd401.net` → student, anything else refused) — `lib/auth/roles.ts`, slice 77. See [ADR 0004](../docs/adr/0004-pkce-state-stored-in-signed-cookie.md) for the PKCE-state-in-cookie rationale.
- Drizzle + Postgres (local homebrew install per [ADR 0005](../docs/adr/0005-local-postgres-not-docker.md)). Seven tables: `assessments`, `items`, `assets`, `students`, `student_accommodations`, `assessment_student_overrides`, `guardrail_events`.
- Auth routes:
  - `/login` — Sign in with Google button. Surfaces inline error if `?error=...` (`account_not_allowed` = wrong domain or unverified address).
  - `GET /api/auth/start` (also POST) — generates PKCE pair + state + nonce, mints `secure-test-pkce` cookie, 302 to authorize endpoint.
  - `GET /api/auth/callback` — verifies state, exchanges code at token endpoint, verifies id_token vs JWKS + nonce, mints `secure-test-session`, 302 to `/dashboard` (or to `pkce.next` if set).
  - `POST /api/auth/logout` — clears `secure-test-session`, 302 to `/login`.
  - `POST /api/auth/exchange` — takes an id_token (from the macOS client's own Google PKCE flow, slice 80), verifies it against `OIDC_ISSUER` + JWKS, derives the role from the email domain and returns the session JWT (`session_token`) as well as setting the cookie. The test-issuer override on the same route is gated by the server-only `ALLOW_TEST_ISSUER=1` and hard-disabled under `NODE_ENV=production`.
- Assessment CRUD (every endpoint requires session; `owner_sub` must equal `session.sub`):
  - `GET /api/assessments` — list the signed-in user's assessments.
  - `POST /api/assessments` — create.
  - `GET /api/assessments/:id` — fetch one + its items.
  - `PATCH /api/assessments/:id` — partial update.
  - `DELETE /api/assessments/:id` — cascade-deletes items.
- Items CRUD + reorder + export + import:
  - `GET /api/assessments/:id/items`, `POST` (discriminated per type), `GET/PATCH/DELETE :itemId`, `POST :id/items/reorder`.
  - `GET /api/assessments/:id/export` — downloads `ItemBundleSchema`-shaped JSON. Emits all three item types (single-select MC, multi-select MC, short text) since slice 8 extended the wire format; `x-skipped-items` is always `0` (kept for back-compat with any external watchers).
  - `POST /api/assessments/import` — `application/json` or `multipart/form-data` (file field). Validates `ItemBundleSchema`, creates assessment + items in one transaction, respects each item's `type`. Cap 1 MB.
- Preview (`GET /preview/:id`) — static, no-JS HTML rendering of an assessment with CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'`. Embedded in the editor as `<iframe sandbox="allow-same-origin">`. See [ADR 0006](../docs/adr/0006-preview-iframe-sandbox.md).
- AI-assist (`POST /api/ai/generate-item`) — provider-abstracted item generation. Gated by `assessment.allow_llm_authoring`. The `mock` provider is the default (no key needed); **Claude Sonnet 4.6 on Amazon Bedrock** (AWS SDK Converse + SigV4 + Converse tool-use, `AI_PROVIDER=bedrock`) and the direct Anthropic API (`AI_PROVIDER=anthropic`) are wired alongside it (slices 25/27, live-validated). See [ADR 0007](../docs/adr/0007-ai-model-selection.md) for the model trade-off matrix and the Bedrock auth/model-id details. Generated proposals are validated through `CreateItemBody.safeParse` before being returned to the editor for review/save.
- Image uploads (`POST /api/uploads/image`, `GET/DELETE /api/assets/:id`, `GET /api/assets`) — storage-provider-abstracted asset path. Today only `local-fs` is wired (writes to `STORAGE_LOCAL_ROOT`, default `./storage`); see [ADR 0008](../docs/adr/0008-storage-abstraction-local-fs-first.md) for the S3 swap path. 5 MB cap; `image/{png,jpeg,gif,webp}` MIME allow-list (raster only — SVG is an active document and the asset route serves bytes inline on the app origin, so it was dropped in the phase-1-2 review, finding B7); per-owner sha256 dedup; ACL = session + `assets.owner_sub`. Asset bytes served with `cache-control: private, immutable`. Integration with item bodies is deferred to a later slice.
- KaTeX math rendering — `$...$` inline and `$$...$$` display delimiters. Server-side render via `lib/math/renderLatex.ts`; preview iframe inlines the KaTeX CSS via `lib/preview/katexCss.ts` (no client-side script needed). Editor shows a debounced live preview (300 ms after last keystroke) via the `renderContent` server action + `MathPreview` client component. K-12 helper macros (`\degree`, `\percent`, `\plusminus`, `\half`, `\third`, `\quarter`); bad LaTeX renders inline-red via KaTeX `errorColor`. See [ADR 0009](../docs/adr/0009-katex-math-rendering.md). PoC-B math rendering is deferred to a follow-up.
- Image refs in item content — `![alt](asset:<uuid>)` markdown-flavored syntax in stems and choice texts. Server-side resolution against the session-scoped `assets` table; unresolved refs render as inline-red `[image not found]` placeholders. Editor has an inline `ImagePicker` per stem / choice that loads owned uploads and click-to-inserts the markdown ref. Math + images render in one unified pipeline (`lib/items/renderItemContent.ts`). See [ADR 0010](../docs/adr/0010-image-refs-in-item-content.md).
- Slice 15 export bundling: `GET /api/assessments/:id/export` now bundles referenced asset bytes inline (`x-bundled-asset-count` response header). `POST /api/assessments/import` re-uploads bundled assets into the importer's account (dedup'd by sha256), then rewrites `asset:<oldUuid>` → `asset:<newUuid>` in every stem / choice. Body cap raised from 1 MB to 50 MB to accommodate bundled blobs. Shared logic in `lib/api/importBundle.ts` powers both the JSON-body route and the `/dashboard/import` server-action page.
- Slice 17: "+ Add choice" now picks the next sequential letter (a, b, c, …) instead of a random 8-char id. Tolerates gaps and non-letter ids. See `lib/items/choiceIds.ts`.
- Slice 18: math notation translator — "Math…" button next to "Image…" on every stem / choice opens a panel where the teacher describes the expression in plain English ("one half plus one third"), the `translateMath` server action returns LaTeX, the panel previews it via client-side KaTeX, and Insert appends `$...$` (or `$$...$$`) to the field. Always-on; not gated by `allow_llm_authoring` (it's a notation converter, not item authoring). Provider abstraction at `lib/ai/mathTranslator/` mirrors slice 7's `ItemGeneratorProvider`. The `mock` provider is the default; **Claude Haiku 4.5 on Amazon Bedrock** (Converse + SigV4, `MATH_TRANSLATOR_PROVIDER=bedrock`) and the direct Anthropic API (`=anthropic`) are wired alongside it (slices 26/27, live-validated) — see [ADR 0011](../docs/adr/0011-math-translator.md).
- Slice 20: assessment-level allowed-accommodations picker — `assessments.allowed_accommodations` jsonb column + Zod-validated picker UI in the metadata section, sourced from `lib/accommodations/catalog.ts` (47 OSPI tools, grouped by OSPI tier with T1–T4/OOB implementation-tier badges). Per the picker-scope decision in `docs/accommodations.md`, all tiers surface — tools the district browser does not render yet are forward-compatible metadata. Companion TIDE field mapping at `docs/accommodations-data-dictionary.md`.
- Slice 21: `construct_altering` opt-in + accommodations bundle round-trip. New `assessments.construct_altering` jsonb column (always a subset of `allowed_accommodations`; enforced in the API layer via `superRefine` + a cross-row check in `PATCH`, plus an auto-clamp when `allowed_accommodations` shrinks). Secondary checkbox per allowed tool in the editor — unchecking the primary cascades to drop the id from `construct_altering`. Bundle export emits both arrays when non-empty (byte-stable for older bundles); bundle import validates against the catalog leniently and reports `accommodations_dropped` / `construct_altering_dropped` counters.
- Slice 22: preview-pane Tier-1 accommodations toolbar. `lib/preview/renderHtml.ts` filters `ACCOMMODATION_CATALOG` by `impl_tier === "T1"` ∩ `allowed_accommodations` and emits `<span class="tool-btn" role="button" aria-disabled="true">` chips above the existing preview banner (no `<button disabled>` so screen-reader users still hear the label). Pure visual demo — CSP unchanged (no script-src added). Iframe `key` now appends a sorted hash of `allowed_accommodations` so the toolbar re-renders on toggle.
- Slice 23a: student roster + TIDE xlsx importer. New `students` + `student_accommodations` tables (partial-unique index on live rows so the soft-deleted ledger doesn't block re-insert; CHECK constraint on the `source` enum). `exceljs`-backed multipart import at `POST /api/accommodations/import` with locked merge semantics (overwrite tide_import / preserve+diff tide_then_edited / never touch manual / soft-remove absent baseline / drop unknown). 448-row TIDE catalog port at `lib/accommodations/tide-catalog.json` generated from `docs/AccommodationData.xlsx` via `scripts/generate-tide-catalog.ts` (manual + committed-output per ADR posture; regen needs `python3` + `openpyxl`). Dedicated `/dashboard/accommodations/import/review` diff screen + per-student editor at `/dashboard/accommodations/[studentId]` with source badge (TIDE / TIDE-edited / manual) per row. CRUD routes enforce source-transition rules: `PATCH` on a tide_import row's value transitions it to tide_then_edited (only on actual value change); `DELETE` on tide-origin rows returns 409 (the soft-remove path during re-import is the only canonical removal).
- Slice 23b: per-assessment student overrides. New `assessment_student_overrides` table (composite-key upsert via `onConflictDoUpdate`; both FKs cascade on parent delete). `POST /api/assessments/[id]/overrides` enforces three invariants: assessment ownership, student ownership, and `tool_id ∈ assessment.allowed_accommodations`. Editor gains a 2-tab strip — `Edit` keeps the existing metadata + accommodations + items flow contiguous; `Per-student overrides` mounts a new `OverridesPanel` with a student dropdown (drawn from `/api/students`) + a tool dropdown filtered to the assessment's allowed tools.
- Slices 25–27: real AI on **Amazon Bedrock** (AWS SDK Converse + SigV4). Item gen = Claude Sonnet 4.6, math translator = Claude Haiku 4.5 (`us.` inference profiles, `AI_PROVIDER=bedrock` / `MATH_TRANSLATOR_PROVIDER=bedrock`); IAM user `secure-test-bedrock`. `mock` stays the CI/test default. Live-validated.
- Slices 28–29: safeguarding guardrail layer. A `GuardrailProvider` wraps the item-generator + math-translator AI surfaces with pre/post checks; `GUARDRAIL_PROVIDER=bedrock` calls Bedrock `ApplyGuardrail`, default off. Every check + outcome is written to the `guardrail_events` table. See [ADR 0012](../docs/adr/0012-safeguarding-guardrails.md).
- Slices 30–31: S3 storage. `STORAGE_PROVIDER=s3` writes assets to an S3 bucket (`S3_BUCKET`); reads/deletes route per the row's persisted `assets.storage_provider`, so a `local-fs`→`s3` switch needs no backfill. CDK stack (`infra/`) provisions an Aurora Serverless v2 cluster + a per-env asset bucket (SSE-S3, public-blocked). See [ADR 0008](../docs/adr/0008-storage-abstraction-local-fs-first.md). `local-fs` remains the default.
- Slice 32: long-text / **essay** item type (fourth type). Authoring only — no scoring yet. Type-specific extras (`max_word_count`, `placeholder`) live in a new `items.config` jsonb bag.
- Slice 33: **rubric** block on essay items, stored in `items.config.rubric`. One unified model serves analytic / holistic / single-point as cardinality variants; two `student_visibility` flags (`during_test`, `with_feedback`). Authoring + storage only; Phase 3 scoring consumes it later.
- Slice 34: **print / Save-as-PDF** view for print accommodations. `GET /preview/:id?print=1` renders a paper variant (drops the preview banner + toolbar; MC → blank mark boxes + letters; short-text/essay → blank write-space) the teacher prints from their own browser. Client-side print, **not** a headless-Chrome server route — see [ADR 0013](../docs/adr/0013-print-pdf-via-client-side-print.md).
- `/dashboard/uploads` — upload form + thumbnail grid + per-asset Open / Delete actions.
- UI:
  - `/dashboard` — list of the user's assessments + "New" / "Import JSON" / "Sign out".
  - `/dashboard/new` — server-action-backed create form.
  - `/dashboard/import` — server-action-backed JSON-file upload.
  - `/dashboard/[id]` — interactive editor (metadata, items CRUD, ↑/↓ reorder, Export JSON, embedded preview iframe).
- `proxy.ts` (renamed from `middleware.ts` per Next 16 — see [docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)) gates `/dashboard/*` and redirects unauthenticated visitors to `/login?next=<path>`.

## Not yet built

- Item-scoring + results (Phase 3): per-item scoring method, AI/human scoring against the slice-33 rubric, comparative judgement, results page.
- Score export to PowerSchool / Schoology (blocked on Phase 3 scoring data).
- Distribution UI (sittings are created through `POST /api/test-sessions` only; the roster it would draw on exists since slice 79); multi-teacher collaboration (Yjs); admin safeguarding-review page.
- Server-side PDF route — deferred; the slice-34 client-side print covers print accommodations today (ADR 0013).

See [`../docs/design-tool-plan.md`](../docs/design-tool-plan.md) and [`../docs/phase-2-slices.md`](../docs/phase-2-slices.md) for the full multi-phase plan.

## Scripts

- `bun run dev` — start the dev server on :3000.
- `bun run dev:clean` — same, but wipes `.next` first. Use it after an unclean
  shutdown / kernel panic, or whenever `bun run dev` spawns more than a handful of
  `.next/dev/build/postcss.js` processes. A bad Turbopack persistent cache
  (`.next/dev/cache/turbopack`) made Next 16.2.6 respawn its PostCSS worker
  until the laptop ran out of memory (six panics on 2026-09-01); a fresh `.next`
  fixed it.
- `bun run build` — `next build`.
- `bun run start` — production server (after build).
- `bun run typecheck` — `tsc --noEmit`.
- `bun test` — auth + OAuth flow + assessments-api integration tests. Set `DATABASE_URL` to the **_test** database before running.
- `bun run db:generate` — drizzle-kit; emits a new migration when `db/schema.ts` changes.
- `bun run db:migrate` — applies pending migrations against `DATABASE_URL`.
- `bun run db:studio` — drizzle-kit studio (browser-based table viewer).
- `bun scripts/mock-issuer.mjs` — local OIDC issuer on :4444 for end-to-end smoke testing.
- `bun scripts/generate-tide-catalog.ts` — regenerate `lib/accommodations/tide-catalog.json` from `docs/AccommodationData.xlsx` via the canonical Python parser. Run when OSPI publishes a new TIDE catalog year; commit the resulting JSON. Requires `python3` + `openpyxl` (the Python script's existing prereqs).

## First-time DB setup

```bash
# Requires homebrew postgresql@16 already started (see ADR 0005).
createdb secure_test_design_tool_dev
createdb secure_test_design_tool_test
DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_dev bun run db:migrate
DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun run db:migrate
```

## Env vars

Copy `.env.local.example` to `.env.local`. Required for any auth flow:

- `DATABASE_URL` — Postgres connection string. **Hardcode your OS username** — `$USER` / `${USER}` does **not** shell-expand inside a dotenv file, so `postgres://$USER@...` in `.env.local` fails with `role "USER" does not exist`. Use e.g. `postgres://yourname@localhost:5432/secure_test_design_tool_dev`. (The `$USER` form in this README's shell commands works because the *shell* expands it there.)
- `DESIGN_TOOL_SESSION_SECRET` — HS256 secret for the session JWT.
- `OIDC_ISSUER` — IdP issuer URL. Production: `https://accounts.google.com` (both `iss` forms Google documents are accepted for that issuer only).
- `OIDC_CLIENT_ID` — the **web** OAuth client id (Google Cloud → Credentials → "Web application"), with `<origin>/api/auth/callback` among its authorised redirect URIs.

Optional:

- `DESIGN_TOOL_PKCE_SECRET` — separate HS256 secret for the PKCE state cookie (falls back to `DESIGN_TOOL_SESSION_SECRET`; distinct value strongly recommended).
- `DESIGN_TOOL_DELIVERY_SECRET` — HMAC key for the per-attempt option ids on match/order delivery (slice 64). Falls back to `DESIGN_TOOL_SESSION_SECRET` and **warns once at first use** when it does, because a recommendation nobody is reminded of is one that mostly does not happen. Set a distinct value: with one key doing both jobs, rotating the session secret for an unrelated reason silently renames the match/order options of every in-progress attempt. Rotate between sittings, never during one.
- `OIDC_CLIENT_SECRET` — required by some IdPs even with PKCE. **Google requires it** for a web-application client at the token endpoint.
- `OIDC_AUDIENCE` — `aud` value(s) to accept, comma-separated (defaults to `OIDC_CLIENT_ID`). With Google, list both the web client id and the native client id the macOS app uses (`web-id,native-id`): the browser callback sees the first, `/api/auth/exchange` sees the second.
- `OIDC_REDIRECT_URI` — explicit override (else derived from request origin).
- `OIDC_SCOPES` — defaults to `openid profile email`.
- `ALLOW_TEST_ISSUER` — dev/test only, **server-only** (never `NEXT_PUBLIC_*`). Ignored and hard-failed when `NODE_ENV=production`.

AI providers (ADR 0007 + ADR 0011):

- `AI_PROVIDER` — `mock` (default) · `bedrock` (Claude Sonnet 4.6 on Amazon Bedrock, live) · `anthropic` (direct Anthropic API). `mock` returns deterministic placeholder items so the editor flow works without any key.
- `MATH_TRANSLATOR_PROVIDER` — `mock` (default) · `bedrock` (Claude Haiku 4.5) · `anthropic`.
- `ANTHROPIC_API_KEY` — required when either provider is `anthropic`. Same key serves both.
- `ANTHROPIC_ITEM_MODEL` / `ANTHROPIC_MATH_MODEL` — optional model overrides (defaults `claude-sonnet-4-6` / `claude-haiku-4-5`).
- `BEDROCK_ITEM_MODEL` / `BEDROCK_MATH_MODEL` — optional Bedrock model-id/inference-profile overrides. `AWS_REGION` selects the Bedrock region; credentials resolve through the standard AWS chain (env keys / `AWS_PROFILE` / SSO / IAM role).

Safeguarding guardrail (ADR 0012) — default off:

- `GUARDRAIL_PROVIDER` — `mock` (default, no-op) or `bedrock` (calls Bedrock `ApplyGuardrail`).
- `GUARDRAIL_ID` / `GUARDRAIL_VERSION` — the Bedrock guardrail identifier + version, required when `GUARDRAIL_PROVIDER=bedrock`.

Asset storage (ADR 0008) — default `local-fs`:

- `STORAGE_PROVIDER` — `local-fs` (default) or `s3`.
- `STORAGE_LOCAL_ROOT` — local-fs write dir (default `./storage`).
- `S3_BUCKET` (required for `s3`), `S3_REGION` (falls back to `AWS_REGION`), `S3_KMS_KEY_ID` (optional SSE-KMS).

## Local end-to-end smoke test (mock issuer)

```bash
# Terminal 1
bun scripts/mock-issuer.mjs

# Terminal 2
DESIGN_TOOL_SESSION_SECRET=dev-session-secret \
DESIGN_TOOL_PKCE_SECRET=dev-pkce-secret \
OIDC_ISSUER=http://localhost:4444 \
OIDC_CLIENT_ID=design-tool-mock-client \
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback \
  bun run dev

# Terminal 3
curl -sL -c /tmp/cookies.txt -b /tmp/cookies.txt \
  -o /tmp/out.html -w "%{url_effective}\n" \
  http://localhost:3000/api/auth/start
# Expect: http://localhost:3000/dashboard

# The mock issuer signs in as mock.teacher@psd401.net (staff). Point the
# dashboard at it and you are signed in; a student-domain address would be
# refused at /login?error=account_not_allowed.
```

## Direct-mint smoke test (slice 2 escape hatch)

For unit-test scenarios where you already hold an id_token (e.g. CI that bypasses the redirect), the slice-2 `/api/auth/exchange` route still works:

The escape hatch is gated on the **server-only** `ALLOW_TEST_ISSUER` and is hard-disabled whenever `NODE_ENV=production`. The exchange route also enforces `aud`, so `OIDC_AUDIENCE` (or `OIDC_CLIENT_ID`) must match the token the signer produces — `smoke-sign.mjs` mints `aud=smoke-client` for `smoke.teacher@psd401.net` (staff); `SMOKE_EMAIL=someone@edtools.psd401.net bun scripts/smoke-sign.mjs` mints a student.

```bash
ALLOW_TEST_ISSUER=1 \
OIDC_AUDIENCE=smoke-client \
DESIGN_TOOL_SESSION_SECRET=dev-secret \
  bun run dev &
bun scripts/smoke-sign.mjs > /tmp/body.json
curl -i -c /tmp/cookies.txt -X POST -H 'Content-Type: application/json' \
  --data @/tmp/body.json http://localhost:3000/api/auth/exchange
```
