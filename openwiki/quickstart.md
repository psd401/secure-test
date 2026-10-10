---
type: Quickstart
title: secure-test wiki quickstart and task router
description: Entry point for the secure-test knowledge base, covering the design tool, shared schema package, macOS SecureTest client, deployment and testing, with a task-routing table from change intent to wiki page, source entry points, tests and validation commands.
tags: [quickstart, navigation, secure-test]
openwiki:
  roles: [repository]
  change_kinds: [navigation]
  source_paths: [README.md, package.json, design-tool/package.json, packages/schema/package.json, client/SecureTestCore/Package.swift]
---

# secure-test wiki quickstart

secure-test is one school district's in-house secure assessment stack: teachers author and run tests in a Next.js **design tool**, students sit them in a locked-down **macOS client**, and a shared **Zod schema package** defines the wire formats between the two. Start with the [architecture overview](architecture/overview.md) for the end-to-end flow and trust boundaries, then jump to the area you are changing.

## Map of the wiki

| Area | Pages |
|---|---|
| System | [Architecture overview](architecture/overview.md), [Wire formats (`packages/schema`)](architecture/wire-formats.md) |
| Design tool | [Auth and access](design-tool/auth-and-access.md), [Data model](design-tool/data-model.md), [Authoring](design-tool/authoring.md), [Sittings and attempts](design-tool/sittings-and-attempts.md), [Scoring and results](design-tool/scoring-and-results.md), [Integrations](design-tool/integrations.md), [Accommodations and roster](design-tool/accommodations-and-roster.md), [AI and safeguarding](design-tool/ai-and-safeguarding.md) |
| Client | [macOS client overview](client/overview.md), [Lockdown and security](client/lockdown-and-security.md) |
| Operations | [Deployment and observability](operations/deployment-and-observability.md) |
| Testing | [Testing and validation](testing/testing-and-validation.md) |

## Task router

All design-tool test commands need `DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test` (abbreviated `$TESTDB` below); see [testing](testing/testing-and-validation.md).

| Change area | Page | Entry points | Key symbols | Focused tests | Minimal validation |
|---|---|---|---|---|---|
| Role, session, route authorization, grants | [auth](design-tool/auth-and-access.md) | `design-tool/proxy.ts`, `lib/auth/*`, `lib/api/access.ts`, `lib/api/grants.ts` | `roleForEmail`, `requireStaff`, `authorizeAssessment`, `levelSatisfies` | `access-enforcement`, `auth-roles` | `cd design-tool && $TESTDB bun test test/access-enforcement.test.ts` |
| Table, column or status vocabulary | [data model](design-tool/data-model.md) | `design-tool/db/schema.ts`, `db/migrations/` | `ATTEMPT_EVENT_KINDS`, `SCORE_STATUSES` | `items-api`, `superseded-scores` | `cd design-tool && bun run typecheck` |
| Item types, import/export, PDF import, preview | [authoring](design-tool/authoring.md), [wire formats](architecture/wire-formats.md) | `lib/api/items.ts`, `lib/api/exportBundle.ts`, `lib/pdfImport/`, `packages/schema/src/items.ts` | `CreateItemBody`, `requireDraft`, `ItemSchema` | `items-api`, `import-api`, `pdf-extract` | `cd packages/schema && bun run build && bun test` |
| Join, attempt, delivery bundle, deadlines, close, peek | [sittings](design-tool/sittings-and-attempts.md) | `lib/api/testSessions.ts`, `lib/api/studentAttempt.ts`, `lib/api/buildDeliveryBundle.ts` | `loadOwnAttempt`, `buildDeliveryBundle`, `deadlineFor` | `attempt-ingest-api`, `delivery-api`, `sitting-closed` | `cd design-tool && $TESTDB bun test test/attempt-ingest-api.test.ts` |
| Drawing upload slots (photo or PDF of paper work) | [sittings](design-tool/sittings-and-attempts.md#drawing-uploads) | `lib/api/responseUploads.ts`, `app/api/attempts/[attemptId]/responses/[itemId]/upload-url/`, `.../upload/` | `registerUpload`, `markUploadComplete`, `ALLOWED_UPLOAD_TYPES` | `response-uploads-api` | `cd design-tool && $TESTDB bun test test/response-uploads-api.test.ts` |
| Scoring, rescore, pass back, results | [scoring](design-tool/scoring-and-results.md) | `lib/scoring/*`, `lib/api/changeScore.ts`, `lib/api/passBackAttempt.ts` | `scoreResponse`, `buildResults`, `planRescore` | `scoring-auto`, `results`, `rescore` | `cd design-tool && $TESTDB bun test test/scoring-auto.test.ts` |
| Teacher review queue, manual score, approve AI proposal | [scoring](design-tool/scoring-and-results.md#teacher-review-queue-and-approval) | `app/api/assessments/[id]/review-queue/route.ts`, `app/api/scores/[scoreId]/approve/route.ts`, `lib/api/reviewActions.ts` | `loadResponseChain`, `checkManualScore` | `review-queue`, `change-score` | `cd design-tool && $TESTDB bun test test/review-queue.test.ts` |
| Gradebook, Google Docs, insights, email/SNS | [integrations](design-tool/integrations.md) | `lib/gradebook/`, `lib/googleDocs/`, `lib/insights/`, `lib/notify/`, `lib/email/` | `sendToPowerSchool`, `buildEvidencePack` | `gradebook-send`, `insights-report` | `cd design-tool && $TESTDB bun test test/gradebook-send.test.ts` |
| Accommodations, TIDE, roster sync | [accommodations](design-tool/accommodations-and-roster.md) | `lib/accommodations/effective.ts`, `lib/roster/*`, `lib/api/resolveStudent.ts` | `resolveEffectiveAccommodations`, `importSnapshot` | `effective-accommodations`, `roster-import` | `cd design-tool && $TESTDB bun test test/effective-accommodations.test.ts` |
| AI provider, guardrail, hand-in screening | [AI](design-tool/ai-and-safeguarding.md) | `lib/ai/provider.ts`, `lib/safeguarding/*` | `getProvider`, `runGuarded`, `scheduleAttemptScreening` | `safeguarding-screening`, `bedrock-provider` | `cd design-tool && $TESTDB bun test test/safeguarding-screening.test.ts` |
| Docker, CDK, Lambda, retention, error capture | [operations](operations/deployment-and-observability.md) | `design-tool/Dockerfile`, `design-tool/infra/lib/`, `lib/retention/sweep.ts`, `instrumentation.ts` | `DesignToolStack`, `sweepEventTables`, `recordServerError` | `docker-entrypoint`, `retention-sweep`, `server-error-record` | `cd design-tool && bun test test/docker-entrypoint.test.ts test/log.test.ts` |
| Client API call, spool, bundle model, page renderer | [client overview](client/overview.md) | `client/SecureTestCore/Sources/SecureTestCore/APIClient.swift`, `ResponseSpool.swift`, `DeliveryBundle.swift`, `AssessmentPage.swift` | `APIClient`, `ResponseSpool`, `DeliveryItem` | `APIClientTests`, `ResponseSpoolTests`, `Renderer*Tests` | `cd client/SecureTestCore && swift test --filter APIClientTests` |
| Lockdown, exits, CSP, message bridge, telemetry | [lockdown](client/lockdown-and-security.md) | `AssessmentLockdown.swift`, `PageShell.swift`, `BridgeChecks.swift`, `client/SecureTest/RealLockdownSession.swift` | `AssessmentLockdown`, `BridgeItemTable`, `AttemptEventReporter` | `AssessmentLockdownTests`, `BridgeChecksTests`, `bridge-limits.test.ts` | `cd client/SecureTestCore && swift test --filter AssessmentLockdownTests` |

Cross-boundary rule: a change to a wire format, event kind or payload limit touches both TypeScript and Swift. Validate the consumer path (`design-tool` typecheck against the built `packages/schema/dist`, then the Swift decode tests), not only the module you edited; see [wire formats](architecture/wire-formats.md).

## Conventions that apply everywhere

- Source comments cite `docs/*-design.md` and ADRs (`docs/adr/`) by slice or decision id (for example "D-5"); read them for rationale, but trust current code and these pages over older READMEs.
- Closed vocabularies live in one TypeScript constant, are mirrored in SQL `CHECK` constraints and route Zod enums, and are mirrored again in Swift where the client uses them.
- Generated and vendored files (`packages/schema/dist`, `db/migrations`, the client's `GeneratedKatexMacros.swift` and `Resources/`) come from their generators; do not hand-edit them.
- The wiki covers `design-tool/`, `packages/schema/` and `client/`. The `poc-*` spike directories are historical records and are not maintained here.

## Backlog

- `design-tool/app/dashboard/**` and `design-tool/components/`: the teacher UI is covered only where it touches API behaviour; no dedicated UI page yet.
- `client/SecureTest/SpeechListener.swift`, `SpeechReader.swift` and `SecureTestCore/.../SpeechToText.swift`, `TextToSpeech.swift`, `MathSpeech.swift`: speech accommodations are mentioned in the client pages but have no dedicated section.
- `client/scripts/` (`vendor-katex.mjs`, `vendor-fonts.mjs`, `launch-client.ts`): referenced as generators, not described step by step.
