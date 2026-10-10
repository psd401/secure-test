---
type: Testing Guide
title: Testing and validation across the monorepo
description: How tests are organised for the design tool (bun test against a real Postgres), the shared schema package, the AWS infra helpers and the Swift SecureTestCore package, with the narrowest validation command for each area and the cross-language drift tests.
tags: [testing, bun, swift, postgres, validation]
openwiki:
  roles: [testing]
  change_kinds: [testing, validation]
  source_paths:
    - design-tool/bunfig.toml
    - design-tool/package.json
    - packages/schema/package.json
    - design-tool/test/bridge-limits.test.ts
    - design-tool/test/helpers/roster.ts
    - client/SecureTestCore/Package.swift
    - client/SecureTestCore/Tests/SecureTestCoreTests/RendererHarness.swift
  test_paths:
    - design-tool/test/items-api.test.ts
    - design-tool/test/bridge-limits.test.ts
    - design-tool/test/roster-fixture-synthetic-ids.test.ts
    - client/SecureTestCore/Tests/SecureTestCoreTests/BridgeChecksTests.swift
  invariants:
    - API route tests need DATABASE_URL to name the secure_test_design_tool_test database and truncate tables between tests.
    - packages/schema is consumed through dist, so rebuild it after editing src.
    - bridge-limits.test.ts reads the Swift BridgeLimits source and fails when it drifts from the TypeScript constants.
  validation_commands:
    - cd design-tool && bun test test/bridge-limits.test.ts
    - cd client/SecureTestCore && swift test --filter BridgeChecksTests
---

# Testing and validation

Three independent test stacks exist. Run only the one that owns the change; the root has no aggregate test script (the root `package.json` only wires git hooks).

| Stack | Runner | Location | Needs |
|---|---|---|---|
| Design tool | `bun test` (`design-tool/bunfig.toml` sets `root = "test"`) | `design-tool/test/*.test.ts` and `*.test.tsx` | Postgres for API and scoring suites |
| Shared schema | `bun test` | `packages/schema/test/` (`delivery`, `items`, `macros`, `responses`, `scoring-method`) | `bun run build` only for consumers |
| macOS client | `swift test` | `client/SecureTestCore/Tests/SecureTestCoreTests/` | macOS toolchain, no Xcode UI or window server |

The `bunfig.toml` root matters: without it `bun test` also sweeps CDK image-asset staging copies under `infra/cdk.out`, which double-run and fail.

## Design tool suites

- **Route tests import handlers directly.** A suite such as `test/items-api.test.ts` calls `POST`/`GET` exported from `app/api/**/route.ts` with a `Request`, mocks `next/headers` and `lib/auth/session` (`mock.module`) to choose the caller (`asUser(sub)`), and talks to a real Postgres. It throws in `beforeAll` unless `DATABASE_URL` contains `secure_test_design_tool_test`, and truncates with `cascade` in `afterEach`, so never point it at a dev database.
- **Setup:** create and migrate the test database once (`createdb secure_test_design_tool_test`, then `DATABASE_URL=... bun run db:migrate`, see [data model](../design-tool/data-model.md)).
- **Provider seams.** Provider modules are tested with a staged fake client (`bedrock-provider`, `anthropic-provider`, `s3-provider`, `storage-provider`) so no cloud call is made; see [AI and safeguarding](../design-tool/ai-and-safeguarding.md) and [integrations](../design-tool/integrations.md) for the factories under test.
- **Access guards are structural.** `access-enforcement.test.ts` and `auth-role-enforcement.test.ts` enumerate `app/api/**` route files from disk and assert what each imports (the `lib/api/access.ts` `authorize*` helpers) and does not contain (inline owner comparisons), so a new route that skips them fails the day it lands; see [auth and access](../design-tool/auth-and-access.md).
- **UI tests** (`*.test.tsx`: monitor controls, reporting print, editors) use static markup (`renderToStaticMarkup`) and pure copy functions; there is no DOM or testing-library harness, so clicks are hand-run checks.
- **Synthetic roster guard.** `roster-fixture-synthetic-ids.test.ts` fails if fixtures or `test/helpers/roster.ts` contain real-shaped student ids. Keep fixture data synthetic ([roster](../design-tool/accommodations-and-roster.md)).
- **Operations helpers** have unit tests too: `docker-entrypoint.test.ts`, `delete-stored-upload.test.ts` (imports `infra/lambda/deleteStoredUpload`), `log.test.ts`, `server-error-record.test.ts`; see [deployment and observability](../operations/deployment-and-observability.md).

## Cross-language drift tests

| Contract | Guard | Fix when it fails |
|---|---|---|
| Swift `BridgeLimits` vs `ESSAY_TEXT_MAX_LENGTH`, `SHORT_TEXT_MAX_LENGTH`, `ESSAY_HTML_MAX_LENGTH`, `RESPONSE_CELL_MAX_LENGTH`, `UPLOAD_MAX_BYTES` | `design-tool/test/bridge-limits.test.ts` regex-reads `client/SecureTestCore/Sources/SecureTestCore/BridgeChecks.swift` | change the Swift constant (keep the `static let name = <int expr>` shape the regex expects) or the TS limit, never one side alone |
| Client-postable event kinds | `attempt-events-api.test.ts` asserts `CLIENT_ATTEMPT_EVENT_KINDS` membership; Swift `AttemptEventKind` mirrors it | add the kind on both sides |
| Item types the client can render | `client-support.test.ts` (`requiredClientUpgrade`) | bump the minimum client version the server demands |

Background: [wire formats](../architecture/wire-formats.md), [client overview](../client/overview.md), [lockdown and security](../client/lockdown-and-security.md).

## Swift client tests

- Everything in `SecureTestCore` is unit-tested; the AppKit target (`client/SecureTest/`) is not, so UI and real lockdown behaviour are manual checks.
- **Renderer tests** (`Renderer*Tests.swift`) execute the page's JavaScript (`AssessmentPage.rendererScript`) in JavaScriptCore through `RendererHarness`, a minimal DOM shim. They prove tree, handlers and posted payloads, not layout or WebKit behaviour.
- **Lockdown tests:** `AssessmentLockdownTests` drives the state machine with `SimulatedLockdownSession` behaviours (`cooperative`, `refusesToBegin`, `hangsOnEnd`, `interruptsAfterBegin`, `slowToBegin`); `SimulatedLockdownSlowTests` covers the real-time `slowToBegin` path. See [lockdown and security](../client/lockdown-and-security.md).
- **Server contract:** `APIClientTests` uses a fake `HTTPTransport`; `DeliveryBundleTests` decodes bundles; `ResponseSpoolTests` includes a hand-written pre-`deferred_at` database shape for migration.
- Fixtures under `Tests/**/Fixtures/` are intentionally not documented here.

## Narrow commands

| Intent | Command | Notes |
|---|---|---|
| One design-tool route suite | `cd design-tool && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test test/<name>.test.ts` | add `--bail` to stop at the first failure |
| Types | `cd design-tool && bun run typecheck` | resolves `@secure-test/schema` through `dist/` |
| Schema | `cd packages/schema && bun run build && bun test` | rebuild before consumer checks |
| Swift class | `cd client/SecureTestCore && swift test --filter <TestClass>` | |
| App target compile | `cd client && xcodebuild -project SecureTest.xcodeproj -scheme SecureTest -destination 'platform=macOS' build` | conditional: only for edits under `client/SecureTest/` or the project file |
| Full design-tool suite | `cd design-tool && DATABASE_URL=... bun test` | conditional: shared helpers, auth, schema or migration changes |
| `next build`, CDK synth | see [deployment and observability](../operations/deployment-and-observability.md) | conditional: only for build, Dockerfile or infra edits |

CI in `.github/workflows/` runs an automated review (`claude-review.yml`) and this wiki's update job (`openwiki-update.yml`); no workflow runs the test suites, so local validation is the gate.
`openwiki-update.yml`); no workflow runs the test suites, so local validation is the gate.
