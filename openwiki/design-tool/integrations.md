---
type: Integration Reference
title: Outbound integrations - gradebook push, Google Docs release, class insights, email and SNS
description: PowerSchool/PowerTeacher Pro gradebook push, Google Docs essay release through a Drive token cookie, evidence-pack class insights with checked AI claims, and the email and SNS notification providers.
tags: [integrations, powerschool, gradebook, google-docs, insights, notifications]
openwiki:
  roles: [integration, workflow]
  change_kinds: [integration, persistence]
  source_paths:
    - design-tool/lib/gradebook/sendPowerSchool.ts
    - design-tool/lib/gradebook/authorizeSend.ts
    - design-tool/lib/gradebook/powerschool.ts
    - design-tool/lib/gradebook/mapping.ts
    - design-tool/lib/googleDocs/release.ts
    - design-tool/lib/googleDocs/driveAuth.ts
    - design-tool/lib/insights/evidencePack.ts
    - design-tool/lib/insights/report.ts
    - design-tool/lib/notify/provider.ts
    - design-tool/lib/email/provider.ts
  symbols: [sendToPowerSchool, authorizeSend, getPowerSchoolClient, planSend, releaseToGoogleDocs, buildEvidencePack, fillReport, getNotifyPublisher, getEmailSender]
  test_paths:
    - design-tool/test/gradebook-send.test.ts
    - design-tool/test/gradebook-powerschool.test.ts
    - design-tool/test/google-docs-release.test.ts
    - design-tool/test/google-drive-auth.test.ts
    - design-tool/test/insights-evidence-pack.test.ts
    - design-tool/test/insights-report.test.ts
  invariants:
    - A gradebook send writes only fully scored attempts and points only, and the acting teacher's users_dcid comes from the roster row never from the request.
    - The insights model sees an evidence pack with no names or ids and every number in a claim is filled server-side from a keyed figure.
    - The Drive token is a one-hour encrypted cookie limited to the drive.file scope and is never stored in the database.
  validation_commands:
    - cd design-tool && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test test/gradebook-send.test.ts
---

# Outbound integrations

Consult this page for anything that sends data out of the design tool: scores to a gradebook, essays to Google Docs, evidence to a model for class insights, and notifications by SNS or email. All of them consume finals produced by [scoring and results](scoring-and-results.md) and scope teacher access through [auth and access](auth-and-access.md). Each one uses a provider or client selected by an environment variable with a safe default (`mock`/off), the same pattern as [AI and safeguarding](ai-and-safeguarding.md).

## Gradebook push (PowerSchool)

Design page: `docs/gradebook-push-design.md`. Route: `POST /api/assessments/[id]/gradebook-send` (`gradebook-categories` supplies the destination category list).

1. `authorizeSend` (`lib/gradebook/authorizeSend.ts`) decides twice, because PowerSchool does not restrict the plugin by user: the caller needs `edit` on the assessment (a `run`-level substitute is refused), and the sender's own address must currently teach the target section on the roster. Both refusals are the access model's 404. The `users_dcid` sent to PowerSchool comes from that roster row, never from the request body.
2. The Zod body accepts `target: "powerschool" | "schoology"`, but only `powerschool` is implemented; any other target returns 400 `unsupported_target`.
3. `sendToPowerSchool` (`lib/gradebook/sendPowerSchool.ts`) selects attempts, creates or reuses the external assignment, writes scores and records the push. Rules: one destination and one section per send; only fully scored attempts are sent, and held-back ones are reported with a reason from `HELD_BACK_REASONS` (`unscored`, `not_on_roster`, `no_dcid`); points only, against the assessment's maximum; a re-send reuses the stored assignment and skips unchanged rows (`skipped_unchanged`); the destination is remembered per (teacher, section) in `gradebook_section_prefs`; a first-send claim row older than `CLAIM_STALE_MS` is treated as a crashed send.
4. `getPowerSchoolClient` (`lib/gradebook/powerschool.ts`) selects the client by `GRADEBOOK_PROVIDER`: `mock` (default, in-memory, records every call) or `live` (the district plugin's `/ws/xte/` endpoints with an OAuth client-credentials token). The module never logs tokens or bodies. `GradebookConfigError` becomes a not-configured response. The score-write body shape is in a file named `powerschoolScoreBodyUnconfirmed.ts` because it has not been confirmed against the live API; treat it as the least certain part.
5. Persistence: `gradebook_pushes`, `gradebook_push_scores`, `gradebook_section_prefs` ([data model](data-model.md)). Each written attempt also gets a server-only `gradebook_sent` attempt event ([sittings and attempts](sittings-and-attempts.md#events-and-the-monitor)). `lib/scoring/rescore.ts` reads `gradebook_pushes`/`gradebook_push_scores` to find sections whose already-sent points a rescore would make stale, and a later send re-writes rows whose points changed ([scoring](scoring-and-results.md)).

Read-only operator checks (`ps-reach`, `student-lookup`) run as one-off ECS tasks ([deployment](../operations/deployment-and-observability.md)).

## Google Docs release

Design page: `docs/google-docs-release-design.md`. Routes: `GET /api/google/drive/start` and `/callback` (Drive consent) and `POST /api/assessments/[id]/google-docs` (the send).

- Auth: `lib/googleDocs/driveAuth.ts` runs a PKCE authorization for the single scope `drive.file` and keeps a one-hour access token in an encrypted httpOnly cookie (`secure-test-gdrive`, path `/api/assessments`). Nothing is stored in the database; no refresh token exists. The callback refuses any token whose granted scopes are not exactly `drive.file` (finding GD-P1).
- Release (`lib/googleDocs/release.ts`): one Google Doc per student per assessment holding every essay, created in the sender's Drive under `<product> / <assessment> / <section>` and shared with the student as editor; optional ownership transfer, double spacing and "include drafts". Skips are decided before anything touches Drive (`SkipReason`: `not_handed_in`, `already_released`, `safeguarding_alert`, `no_email`, `no_essay`, `drive_auth_expired`), concurrency is 3, and a send where everyone is skipped creates no folders. `mode: "skip" | "new"` decides what happens to students who already have a Doc.
- Persistence: `google_doc_folders`, `google_doc_releases`. The content builders (`content.ts`) reuse the results and rubric views, and essay HTML goes through the same sanitiser as the reporting views.

## Class insights

Design page: `docs/class-insights-design.md`. Routes: `POST /api/assessments/[id]/class-insights` (report) and `/class-insights/chat`.

- `buildEvidencePack` (`lib/insights/evidencePack.ts`) is the only thing a model sees. The pure half `buildEvidencePackFromData` holds every exclusion rule: no names, emails, student numbers, SSIDs or internal ids, and no student-written text except anonymous short-text answer clusters (and anonymous fill-in-blank counts), with answers on responses that have an open safeguarding alert excluded. The server keeps the pseudonym `names` map and swaps names back in at render time.
- The model writes claims in four sections (strengths, growth, celebrations, next steps). `fillReport` (`lib/insights/report.ts`) refuses or drops any claim it cannot check: it never repairs one. A number must be a `{key}` reference into `pack.figures`; labels (`Q3`, `S4`) and tags must exist in the pack; and the digit rule says that, after references, labels and allowed strings are removed, the text contains no digit at all. Celebrations must cite a student and have evidence behind them. Stored rows hold `[[S4]]`/`[[Q3]]` markers, not names.
- Both routes call `runGuarded` ([AI and safeguarding](ai-and-safeguarding.md)). Tables: `class_insight_reports`, `class_insight_threads`, `class_insight_turns`.

## Notifications

- `lib/notify/provider.ts` (`NOTIFY_PROVIDER`: `mock` default, `sns`) publishes the feedback and alarm emails. A publish failure is logged and swallowed so a teacher filing feedback never sees a 500.
- `lib/email/provider.ts` (`EMAIL_PROVIDER`: `mock` default, SES via `sesProvider.ts`) sends share notifications (`shareNotifications.ts`, see `docs/share-notifications-design.md`) and safeguarding alert emails (`safeguardingNotifications.ts`).

## Change navigation

| Change | Start at | Tests |
| --- | --- | --- |
| Gradebook rules or payloads | `lib/gradebook/mapping.ts` (`planSend`), `sendPowerSchool.ts`, `powerschoolPayloads.ts` | `gradebook-send.test.ts`, `gradebook-powerschool.test.ts`, `gradebook-send-dialog.test.ts` |
| Add a gradebook target | add a client beside `powerschool.ts`, branch in `gradebook-send/route.ts`, extend `GradebookTarget` in `db/schema.ts` | same files |
| Drive consent or release behaviour | `driveAuth.ts`, `release.ts`, `content.ts` | `google-drive-auth.test.ts`, `google-docs-release.test.ts`, `google-docs-send-dialog.test.ts` |
| Insights exclusions or claim checks | `evidencePack.ts`, `report.ts`, `reportPrompt.ts`, `chat.ts` | `insights-evidence-pack.test.ts`, `insights-report.test.ts`, `insights-chat.test.ts`, `insights-*-route.test.ts` |

Do not exercise `live` gradebook or Drive paths in automated checks; the mock client and injected `DriveClient` exist for that. Related: [scoring and results](scoring-and-results.md), [accommodations and roster](accommodations-and-roster.md) (section and `dcid` data used for the send).
