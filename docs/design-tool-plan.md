# Assessment Design Interface — Plan

## Context

PSD's secure-test browser (the macOS student app) consumes JSON assessment payloads but has no first-party authoring tool. Teachers currently have nowhere to build the assessments the browser delivers. This plan defines the design interface — a web app where teachers create, edit, distribute, and review assessments, plus where students see released results.

Eight requirements drive the design:

1. Teacher-built assessments with multiple item types (emphasis on machine-scorable), per-item scoring choice (auto / AI / human / hybrid), comparative-judgement support (No More Marking style), toggleable LLM-assisted item authoring, mixed text / image / math output.
2. Import from JSON, PDF, CSV, Google Docs.
3. Distribution by roster, grade level, school.
4. Hidden / accountability assessments invisible to assigned teachers.
5. Multi-teacher collaboration on a single assessment.
6. Student results page; teacher releases manually; LLM feedback requires a double opt-in (teacher AND student).
7. Score export to CSV, PowerSchool PowerTeacher, Schoology.
8. PDF export for print accommodations.

Most of this is unblocked by the project's two pending external dependencies (Apple AAC entitlement, ClassLink Partner Portal). The design tool only needs ClassLink staff SSO, which uses the same OIDC code path PoC-C is verifying. The student-side AAC entitlement does not gate any design-tool work.

## Recommended Approach

A new directory `secure-test/design-tool/` in this repo, holding a Next.js 16 web app + a CDK-deployed AWS backend, sharing an item/assessment schema package with the rest of the secure-test code.

### Stack

- **Frontend**: Next.js 16 (App Router) + React 19 + Tailwind 4 + shadcn/ui + Zod. Matches `psd-strategic-dashboard-v2`. Confirm AI Studio's actual stack and adjust if it diverges (unresolved 1.1).
- **Backend**: CDK-deployed AWS stack in James's playground account (<account-id>, us-west-2). Stack name `SecureTestDesignTool`. API Gateway → Hono on a single Lambda router (matches `diagnoser-amplify` pattern). Drizzle ORM → Aurora Postgres Serverless v2 for assessments, items, versions, collaborators, scores. S3 (SSE-KMS) for media uploads (images for items) and PDF / CSV export artifacts.
- **Auth**: ClassLink LaunchPad OIDC for teachers (the same code path PoC-C runs), with `classLink_role` claim used to gate teacher vs. admin features. Bearer-token JWT minted by an auth Lambda on first login, validated on every request. Cookie-based session for the Next.js app, refresh handled via the same flow.
- **Item schema**: Zod-defined, lives in a shared `secure-test/packages/schema/` directory (introduces a small bun-workspaces refactor so the macOS client's Swift `ItemModel.swift` and the web tool's TypeScript model are generated from / kept in sync with the same Zod source of truth). Extends PoC-B's MC + short-text shape with: long-text, multi-select MC, rubric block, media block (image refs), math block (KaTeX-rendered LaTeX), accommodations metadata (the four-tier `in_app` / `aac_flags` / `permissive_mode_apps` / `out_of_band` structure from `docs/accommodations.md`).
- **AI integration**: Anthropic Claude (Opus / Sonnet) called from Lambda. Two surfaces: "Generate item with AI" (authoring), "Score this response" (per-item, optional). Per-assessment toggle controls visibility of the AI authoring button. Per-item scoring choice (auto / AI / human / hybrid) controls runtime behavior.
- **Math / media rendering**: KaTeX for math (client-side, fast, pure JS). S3 presigned PUT for image uploads (max 5 MB, image/* MIME enforced at presign time).
- **Collaboration**: MVP uses last-write-wins with optimistic concurrency tokens (rev number on each save); Phase 2 swaps in Yjs + Hocuspocus for real-time multi-cursor editing.
- **PDF export**: Lambda + headless Chromium via `@sparticuz/chromium-min` + Playwright. Renders the assessment's HTML preview to PDF.

### System diagram

```
                +-------------------------------------------------------------+
                |  TEACHERS (browser, ClassLink-authenticated)                |
                |  - design assessments, manage item bank, view scores        |
                |  - student-results release UI                               |
                +---------------------+---------------------------------------+
                                      |
                                      | HTTPS + cookie session
                                      v
+---------------------------------------------------------------------------+
|  Next.js 16 (App Router) — secure-test/design-tool/                       |
|     pages: dashboard, assessment editor, item bank, results review        |
|     server actions: CRUD + publish (call the backend Lambda)              |
|     KaTeX math, shadcn forms, Zod validation                              |
+---------------------+----------------------------------+------------------+
                      |                                  |
                      | HTTPS (API Gateway)              | S3 presigned PUT
                      v                                  v
+----------------------------------------------+   +---------------------+
|  Hono on Lambda (one router function)        |   |  S3 (assets)        |
|  routes:                                      |   |  - item-media/      |
|    /assessments [GET POST PUT DELETE]         |   |  - exports/pdf/     |
|    /assessments/:id/items                     |   |  - exports/csv/     |
|    /assessments/:id/versions                  |   +---------------------+
|    /assessments/:id/distribute                |
|    /assessments/:id/results                   |   +---------------------+
|    /ai/generate-item, /ai/score-response      |   |  Aurora Postgres    |
|    /imports/json, /exports/{pdf,csv,           |   |  via Drizzle        |
|       powerschool,schoology}                  |   |  - assessments      |
|                                                |   |  - items            |
+-------------+--------------------+-----+-------+   |  - versions         |
              |                    |     |           |  - collaborators    |
              | Anthropic API      |     |           |  - distributions    |
              v                    |     |           |  - responses        |
       +--------------------+      |     |           |  - scores           |
       |  Claude            |      |     |           |  - audit_log        |
       |  (item gen + AI    |      |     |           +---------------------+
       |   scoring)         |      |     |
       +--------------------+      |     |
                                   |     |
   +---------- ClassLink OIDC (PoC-C verify Lambda is the bridge) ---------+
   |  staff login -> id_token -> /auth/exchange -> session JWT              |
   +-----------------------------------------------------------------------+
                                         |
                                         | (Phase 2+)
                                         v
                            +-----------------------------+
                            |  OneRoster (ClassLink RS)   |
                            |  pull-sync: students,        |
                            |  sections, schools, grades   |
                            +-----------------------------+
```

### Phasing

Strict on MVP scope; everything else explicitly deferred and not implemented in Phase 1.

**MVP (Phase 1) — what gets built in the first cut**

- Teacher login via ClassLink OIDC (reusing PoC-C's verify Lambda as the token-exchange bridge; new session-JWT mint endpoint).
- CRUD on assessments with metadata (name, description, time limit, allowed accommodations array).
- Add / edit / reorder / delete items. Item types: **multiple choice (single-select), multiple choice (multi-select), short text**. Each with stem (rich text with KaTeX math), choices (for MC), and `correct_answer` / `correct_choice_ids`.
- Per-assessment toggle: "Allow LLM-assisted item authoring." When on, a "Generate item with AI" button calls `/ai/generate-item` with the assessment's context and proposes an item the teacher edits before saving.
- Save / draft / publish lifecycle. Publishing locks the assessment for editing (Phase 2 versioning will allow forking).
- Export as JSON — the file format the student app's `ItemBundle` already consumes.
- Import from JSON — same format. Validates against the Zod schema before accepting.
- Preview pane that renders the assessment in an iframe with the same hardened CSP as PoC-B's WKWebView (`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`).

**Phase 2 — distribution, more types, collaboration**

- Long-text / essay items. Rubric block on essay items (analytic + holistic options).
- Image upload via S3 presigned PUT; image block in items. (Local-fs upload + in-stem image refs already shipped in slices 10 + 12; S3 swap pending CDK packaging per ADR 0008.)
- Distribution UI: assign to roster / grade level / school. Depends on OneRoster sync (Phase 2 of the broader project plan).
- Multi-teacher collaboration via Yjs + Hocuspocus over WebSocket. Last-write-wins MVP gets swapped out.
- Hidden / "accountability" assessments — visible only to admin role (`classLink_role` claim check) and explicitly-named co-authors; not visible to assigned teacher.
- PDF export for print accommodations.
- CSV export of scores; PowerSchool PowerTeacher and Schoology CSV exports (formats reverse-engineered from sample exports — neither vendor publishes the schema).
- **Safeguarding + reporting module** (`secure-test/design-tool/safeguarding/`). Architectural precedent: AI Studio's `lib/safety/bedrock-guardrails-service.ts` + `infra/lib/guardrails-stack.ts` + `agent_telemetry` tables + `app/(protected)/admin/agents/_components/agent-safety-table.tsx` + `docs/features/k12-content-safety.md`. Built on AWS Bedrock Guardrails (content filters, denied topics, PII redaction, prompt-injection detection). In our project: wraps the slice-7 `ItemGeneratorProvider` + slice-18 `MathTranslatorProvider` with pre- and post-call guardrail checks; telemetry table stores every check + outcome; admin-only `/dashboard/admin/safeguarding` page surfaces flagged content. Most valuable once Phase 3 student essay responses land — that's when human review of model-generated feedback becomes load-bearing.

**Phase 3 — scoring, results, advanced imports**

Status through 2026-07-09: the buildable core (scoring loop + item imports) shipped as slices 35–42 — per-slice detail in [`phase-3-slices.md`](phase-3-slices.md). Remaining bullets are externally blocked or explicitly deferred (reasons in that file's "Deferred / blocked" section).

- ✅ **Per-item scoring method picker (auto / AI / human / hybrid)** — slice 36 (`items.config.scoring_method`).
- ✅ **AI scoring via Claude with mandatory rubric; human-in-the-loop review queue** — slices 38 (essay scorer, Bedrock live-validated) + 39 (approve / override / re-run). Confirmed: `ai` = human approves every score; `hybrid` = confidence ≥ 0.85 auto-finalizes.
- ✅ **Attempts + responses + append-only scores schema; pure auto-scoring** — slices 35 + 37 (one final per response; MC exact / short_text normalized-exact).
- ⏳ **Comparative judgement (Bradley-Terry)** — deferred; needs its own ADR.
- ⏳ **Student results page + LLM feedback double opt-in** — blocked on ClassLink (student identity/roles). The *teacher-facing* results matrix + generic CSV export shipped as slice 40 (finals only).
- **Import:** ✅ CSV template-driven row-per-question (slice 41); ✅ PDF text-layer via `unpdf` + LLM extraction (slice 42); ✅ OCR for scanned PDFs (Phase 4 slices 43–45, Bedrock Converse document blocks, ADR 0015); ⏳ Google Docs (Docs API → text → LLM-parse) — deferred, DPA check first (only Phase 3 feature outside the AWS bubble).
- ⏳ **More item types: match, order, hotspot, drawing/upload** (still no QTI commitment) — not yet sliced.
- ⏳ **Score exports — PowerSchool PowerTeacher + Schoology CSV** (from Phase 2 list) — unblocked by slice 37 data but gated on sample vendor exports to reverse-engineer.

### Accommodations slice plan

Two parallel paths. Path A (design tool) lands first — it's the remaining Phase 1 MVP gap. Path B (student runtime) is sketched for forward reference; commit to its timing only once the AAC entitlement clears or a decision is made to extend PoC-B further.

Tier definitions live in `docs/accommodations.md`. TIDE field mappings live in `docs/accommodations-data-dictionary.md`.

#### Path A — design-tool slices (next work after slice 19)

**Slice 20 — `allowed_accommodations` schema + picker UI**

- Add `allowed_accommodations: string[]` column to `assessments` Drizzle table; migration in `db/schema.ts` + generated SQL.
- Catalog source: a hand-curated `lib/accommodations/catalog.ts` enumerating every OSPI tool with `{ id, label, tier, strategy, oosbi (out-of-OSPI-band flag) }`. Seeded from `docs/accommodations.md` tables. *Surfaces all tiers* per the picker-scope decision in `accommodations.md` — Tier 4 tools are forward-compatible metadata even though the browser does not render them yet.
- Editor UI: new "Accommodations" tab on `/dashboard/[id]`. Grouped checkboxes by OSPI tier (Universal / Designated / Accommodation), each annotated with its implementation tier (T1–T4 + "out-of-band").
- Export/import: the array round-trips through the existing bundle format (`lib/api/importBundle.ts`). Zod schema in `@secure-test/schema` validates against the catalog ID list.
- Preview: no runtime behavior change in this slice — the iframe ignores `allowed_accommodations`. Wired in later slices when runtime tools land (Path B).
- Tests: drizzle migration applies cleanly; new field round-trips through export/import; picker UI renders all tiers and persists selection; Zod rejects unknown catalog IDs.

**Slice 21 — construct-altering opt-in (Q2.2)**

- For each picked accommodation, a per-assessment "this is construct-altering" toggle. Default off; on means "students who require this accommodation should not take this assessment OR receive it under a separate calibration". Stored as `construct_altering: string[]` on assessments.
- Surface this in the picker tab as a secondary checkbox next to each selected tool.
- The classic OSPI example is "TTS on an ELA reading test" — flagging this allows downstream reporting to disaggregate scores.
- Tests: round-trip through export/import; cannot mark a tool construct-altering unless it is also in `allowed_accommodations`.

**Slice 22 — preview-pane respects toggles (Tier 1 only)**

- The preview iframe receives the `allowed_accommodations` array and renders a small toolbar above the item with the Tier 1 enabled tools (no functional effect yet — the toolbar is a visual demo so teachers see what students would see).
- Skip Tier 2–4 — they are runtime work, not preview work.
- Tests: preview iframe receives the array via `postMessage`; toolbar reflects the picker selections.

**Slice 23 — TIDE import groundwork (separate plan)**

- This is "Slice B" from the prior accommodations plan. Schema for per-student records (`students`, `student_accommodations` keyed on `(ssid, subject)`), production xlsx library selection (likely `exceljs` for streaming + validation), `/dashboard/accommodations/import` route validating against the dictionary catalog.
- Lands after Slice 22. Detailed plan in a follow-up document when ready.

#### Path B — student-runtime slices (PoC-B or post-entitlement macOS client)

Order optimizes for shared plumbing.

**Slice R1 — session-config → CSS variables foundation**

- Single slice that ships Color Contrast (8 themes), Optional Font (bundled dyslexia font), Zoom Test Level (5 standard levels), Streamline Interface Mode in one go. All four share one mechanism: read the session's accommodations payload at runner start, set CSS custom properties on the WKWebView's root element, ship a CSS variable theme.
- Bundles OpenDyslexic-Regular into the client. CSS variables: `--accom-bg`, `--accom-fg`, `--accom-font`, `--accom-zoom`, `--accom-layout`.

**Slice R2 — per-item interaction features**

- Highlighter + Strikethrough + Mark for Review. All three are per-item state additions to the existing MC UI; share the same persistence shape (per-item JSON in session storage).

**Slice R3 — overlay features**

- Masking + Hybrid Masking + Line Reader. Introduce a new DOM overlay layer (`<div id="accom-overlay">`) above the item content. All three render into that layer.

**Slice R4 — layout features**

- Expandable Items / Expandable Stimuli. Responsive layout work; interacts with R1's Streamline variant.

**Slice R5+ — Tier 2 features as separate slices**

- TTS Test Content + Student Responses (one slice, AVSpeechSynthesizer).
- Digital Notepad + Global Notes (one slice).
- Mouse Pointer (one slice, may need post-entitlement verification first).
- Word Completion, math reference panels, Calculator each their own slice.

### Reuse / standards alignment

- Reuse the **item schema** seed from PoC-B's `ItemModel.swift` (`/Users/cantonwinej/code/secure-test/poc-b-test-loop/client/Sources/PocBClient/ItemModel.swift`) — the new Zod schema is the source-of-truth and the Swift model regenerates from it.
- Reuse the **accommodations 4-tier structure** from `docs/accommodations.md` — assessment metadata carries the allowed `in_app` / `aac_flags` / `permissive_mode_apps` lists.
- Reuse the **PoC-C verify Lambda + JWKS / OIDC discovery code** from `poc-c-classlink-sso/infra/lambda/verify-id-token.ts` as the foundation for teacher auth. Add an `/auth/exchange` route that converts the id_token to a design-tool session JWT.
- Reuse the **CDK + bun + esbuild + Lambda** pattern from `poc-b-test-loop/infra/` and `poc-c-classlink-sso/infra/`. Stack name `SecureTestDesignTool`.
- Reuse the **hardened-CSP HTML pattern** from `poc-b-test-loop/client/Sources/PocBClient/TestRunner.swift`'s `renderHTML()` for the assessment preview iframe.
- Reference QTI 3.0 as a schema design influence; do **not** adopt it directly (heavy, low K-12 adoption, no good open tooling — per standards research).
- Reference Bradley-Terry comparative judgement; implement in-house when Phase 3 lands.

## Critical files (to be created)

- `secure-test/design-tool/package.json` — Next.js 16 + React 19 + Tailwind 4 + shadcn + Zod.
- `secure-test/design-tool/app/` — App Router pages: dashboard, editor, item bank, results.
- `secure-test/design-tool/app/api/auth/exchange/route.ts` — OIDC id_token → session JWT.
- `secure-test/design-tool/components/AssessmentEditor.tsx` — main editor surface.
- `secure-test/design-tool/components/ItemEditor.tsx` — per-item form.
- `secure-test/design-tool/components/PreviewIframe.tsx` — sandboxed iframe matching PoC-B's CSP.
- `secure-test/design-tool/lib/ai/generateItem.ts` — Claude call.
- `secure-test/design-tool/infra/lib/design-tool-stack.ts` — CDK stack.
- `secure-test/design-tool/infra/lambda/api.ts` — Hono router.
- `secure-test/design-tool/infra/lambda/auth-exchange.ts` — token exchange.
- `secure-test/design-tool/db/schema.ts` — Drizzle schema for assessments, items, versions, collaborators.
- `secure-test/packages/schema/` — new shared package for the Zod item/assessment schema (introduces bun workspaces at repo root).
- `secure-test/packages/schema/index.ts` — exports the Zod types and TS types.
- Top-level `secure-test/package.json` — workspaces declaration listing `design-tool` and `packages/schema`.

## Verification

- **Schema package**: `cd secure-test && bun install`, then `bun run --filter @secure-test/schema build` produces TypeScript types. The existing PoC-B's `ItemModel.swift` continues to compile (existing `swift build` in `poc-b-test-loop/client/` still passes); the schema package's TypeScript types match the Swift fields one-for-one for the MC + short-text subset.
- **Backend deploys**: `cd secure-test/design-tool/infra && bun install && bunx cdk synth && bunx cdk deploy --require-approval never`. Stack `SecureTestDesignTool` reports an API URL and a Postgres connection string output.
- **Auth flow**: a teacher logs into the dashboard via ClassLink; the network panel shows the OIDC redirect, the id_token POST to `/auth/exchange`, the session cookie set, and the dashboard rendering with the teacher's `classLink_sourcedId` visible in a header.
- **Assessment round-trip**: create a new assessment named "MVP smoke test", add three MC items, click Export JSON. Use the same JSON file as the `items.json` in `poc-b-test-loop/client/Sources/PocBClient/Resources/` (replace and rebuild), launch PoC-B's client, see the three items, answer them, observe the answers in CloudWatch — proves the schema round-trip works between authoring and delivery.
- **LLM-assist**: with the per-assessment toggle on, click "Generate item with AI", get a proposed item, edit it, save it, export the assessment, and verify the new item still renders in PoC-B's client.
- **Preview parity**: the editor preview iframe and the PoC-B WKWebView produce visually identical renderings for at least three test items (manual side-by-side check). CSP headers match.
- **Unit tests**: Zod schema accepts a known-good JSON file, rejects malformed inputs with clear error messages. Drizzle migrations run cleanly against a local Postgres.

## Unresolved Questions

1.1 AI Studio actual stack — confirm Next.js + Drizzle + Aurora + Hono is the match, or pivot.
1.2 Bun workspaces refactor — acceptable now, or defer until two consumers actually need the shared schema?
1.3 Anthropic API access — RESOLVED: Claude via Amazon Bedrock (SigV4), dedicated IAM user `secure-test-bedrock`; no direct Anthropic key. See ADR 0007.
1.4 Aurora Serverless v2 cost vs. RDS or DynamoDB — does this fit the playground budget?
1.5 ClassLink staff SSO — does the same Partner Portal application cover staff, or do we need a second registration?
1.6 Teacher-vs-admin role gating — is `classLink_role` claim reliable, or do we maintain our own role table?
1.7 Storage of student responses — same Aurora DB or separated for privacy / retention?
1.8 PowerSchool / Schoology CSV schemas — who can provide a sample export for reverse-engineering?
1.9 Existing PSD assessment authoring tools — is anything already in production we'd be replacing or coexisting with?
1.10 Pilot population — same as broader-project pilot, or design tool gets its own pilot teachers?
