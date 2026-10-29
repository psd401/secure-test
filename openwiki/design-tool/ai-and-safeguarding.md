---
type: Subsystem Reference
title: AI providers, guardrails and safeguarding screening
description: The provider-selector pattern behind every AI surface (item generation, PDF import, math translation, essay scoring, rubric extraction, standards suggestion, class insights), the Bedrock guardrail wrapper, and the hand-in safeguarding screening that writes alerts and withholds AI scores.
tags: [ai, bedrock, guardrails, safeguarding, providers]
openwiki:
  roles: [architecture, integration]
  change_kinds: [public-api, security, lifecycle]
  source_paths:
    - design-tool/lib/ai/provider.ts
    - design-tool/lib/ai/essayScorer/provider.ts
    - design-tool/lib/safeguarding/provider.ts
    - design-tool/lib/safeguarding/guard.ts
    - design-tool/lib/safeguarding/screening/screen.ts
    - design-tool/lib/safeguarding/screening/retry.ts
    - design-tool/lib/safeguarding/alerts.ts
    - design-tool/instrumentation.ts
  symbols: [getProvider, getGuardrailProvider, getScreeningProvider, getEssayScorerProvider, runGuarded, scheduleAttemptScreening, screenResponse, startScreeningRetry, injectionAlertFor]
  test_paths:
    - design-tool/test/bedrock-provider.test.ts
    - design-tool/test/anthropic-provider.test.ts
    - design-tool/test/safeguarding.test.ts
    - design-tool/test/safeguarding-screening.test.ts
    - design-tool/test/safeguarding-route.test.ts
    - design-tool/test/essay-scorer.test.ts
  invariants:
    - Every provider selector defaults to mock (or off), so CI and local dev need no credentials.
    - A screening failure never fails or slows a hand-in; an unscreened answer is retried.
    - A prompt-injection alert withholds the AI score until the teacher forces it.
    - Guardrail telemetry stores a bounded snippet and drops match-bearing detail.
  validation_commands:
    - cd design-tool && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test test/safeguarding-screening.test.ts
---

# AI providers, guardrails and safeguarding screening

AI shows up in many places in the design tool, but always behind the same shape: an interface, a `mock` implementation that is the default, a Bedrock implementation, sometimes a direct Anthropic implementation, and a selector function that reads one environment variable. Read this page before adding a new AI feature or changing how model output reaches a teacher or student.

## Provider selectors

| Surface | Selector | Env var (default) | Notes |
|---|---|---|---|
| Item generation (single and batch) | `getProvider()` in `lib/ai/provider.ts` | `AI_PROVIDER` (`mock`; `bedrock`, `anthropic`) | Claude Sonnet 4.6 on Bedrock per ADR 0007. Route `app/api/ai/generate-item(s)`, gated by `assessment.allow_llm_authoring`. The batch flow (up to ten proposals, per-element validation) is in [batch AI item generation](batch-item-generation.md). |
| Math notation translator | `lib/ai/mathTranslator/provider.ts` | `MATH_TRANSLATOR_PROVIDER` (`mock`) | Claude Haiku 4.5. Server action `app/actions/translateMath.ts`. Always on, since it is a notation converter, not authoring. ADR 0011. |
| PDF import extractor | `lib/pdfImport/provider.ts` | `PDF_EXTRACTOR_PROVIDER` (`mock`) | Scanned PDFs go to Bedrock document blocks (ADR 0015). Not gated by `assessment.allow_llm_authoring` (decision of 2026-10-27; Word import follows it). See [PDF import](pdf-import.md#pipeline) and [authoring](authoring.md#getting-content-in-and-out). |
| Essay scorer | `lib/ai/essayScorer/provider.ts` | `ESSAY_SCORER_PROVIDER` (`mock`) | Used by `lib/scoring/aiScoreResponse.ts`. See [scoring](scoring-and-results.md). |
| Rubric extractor | `lib/ai/rubricExtractor/provider.ts` | `RUBRIC_EXTRACTOR_PROVIDER` (`mock`) | Rubric upload to structured rubric. |
| Guardrail | `lib/safeguarding/provider.ts` | `GUARDRAIL_PROVIDER` (`off`; `mock`, `bedrock`) | `null` when off: callers run the AI call directly and write no telemetry. `bedrock` is `bedrockGuardrail` in `lib/safeguarding/bedrockGuardrail.ts`, which calls the standalone Bedrock `ApplyGuardrail` API so the same check covers every AI provider; `mock` is `mockGuardrail` in `lib/safeguarding/mockProvider.ts`. |
| Hand-in screener | `lib/safeguarding/screening/provider.ts` | `SAFEGUARDING_SCREENER_PROVIDER` (`off`; `mock`, `bedrock`) | Off means the hand-in does no extra work. |
| Email, notify | `lib/email/provider.ts`, `lib/notify/provider.ts` | `EMAIL_PROVIDER`, `NOTIFY_PROVIDER` (`mock`) | SES and SNS in production. |

Shared plumbing: `lib/ai/bedrockConverse.ts` (Converse + tool-use over SigV4), `lib/ai/anthropicClient.ts`, `lib/ai/sdkResponse.ts`, and the `*Core.ts` files (`itemGenCore`, `itemBatchCore`, `standardsSuggestCore`, `mathCore`, `scoreCore`, `extractCore`) which hold prompts and validation shared by mock and real providers. Model output is never trusted: item proposals pass through `CreateItemBody.safeParse`, math through `mathNormalize`, fill-in-the-blank through `fillBlankNormalize`, and class-insight text through the claim checks described in [integrations](integrations.md#class-insights).

Two more modules are shared across surfaces. `lib/ai/mathPromptRule.ts` exports `MATH_DOLLAR_RULE`, the prompt sentence that tells a model to write a currency amount as `\$` and to wrap digit-led math in `${...}$` unless it contains a LaTeX command, `^` or `_`. That rule matches the renderers, so `itemGenCore.ts`, `itemBatchCore.ts` and the PDF extraction prompt in `lib/pdfImport/extractCore.ts` all embed it; `test/math-prompt-rule.test.ts` renders its examples to keep the two in step. `lib/ai/documentUpload.ts` holds `ALLOWED_UPLOADS` and `allowedUploadFor` (PDF and DOCX go to the model as document blocks, Markdown and plain text are decoded to text) and the shared `MAX_UPLOAD_BYTES` cap. Batch generation and rubric extraction both call it, so a new upload type belongs there and not in either route.

`lib/ai/textOnlyPromptRule.ts` exports `TEXT_ONLY_RULE`, which tells a model that items carry no attachments and must never refer to a diagram, picture, graph, chart, table, map or figure. It exists because a 2026-10-27 hand-check (finding F-6) produced a generated stem beginning "The diagram below shows…" with no diagram. Both `itemGenCore.ts` and `itemBatchCore.ts` embed it, and `test/text-only-prompt-rule.test.ts` checks that the rule is present. A new item-writing prompt should embed it as well.

The prompt rule is a request, and models often ignore it for digit-led math. Under the renderers' rule, a single `$` followed by a digit opens math only when the run holds a LaTeX command, `^` or `_`, so a proposal such as `$5x + 3 = 28$` would print raw. `lib/ai/mathNormalize.ts` is the server-side backstop (finding BG-E1): `normalizeProposalMath` applies `normalizeDigitLedMath` to the stem, choice texts, match pairs and dropdown options of an AI proposal before `CreateItemBody` validation. The rewrite wraps a run as `${…}$` only when it looks like math, not a dollar amount (no edge spaces, no word of two or more letters, ends in a letter, digit, `)` or `}`), so `$5 to $10` stays as written. Answer keys are never rewritten. The rule is pinned by `test/math-normalize.test.ts`, which the prompt-rule test complements. The same normalizer runs on the batch, single-item and PDF-import paths.

Essay scoring has its own call budget. `lib/ai/essayScorer/bedrockProvider.ts` sets `ESSAY_SCORE_CALL_TIMEOUT_MS` (60 s) on every scoring call, because the shared Bedrock client has no request timeout and a hung call could outlive the 5-minute scoring claim in [AI scoring](scoring-and-results.md#batch-and-per-essay-ai-scoring). A reply that is not readable JSON, or whose points disagree with the chosen rubric level, gets one more call (`MAX_ATTEMPTS` = 2 calls per essay in total). A reply cut off at `max_tokens` is not retried, and a reply that parses but fails the shape check is reported at once. Before the rubric check, a model total that disagrees with the sum of its chosen criterion points is replaced by that sum, but only when the corrected result then passes the rubric bounds (`reconcilePointsTotal` in `lib/ai/essayScorer/scoreCore.ts`, logged as `essay_score_total_corrected`); a teacher's manual score is never repaired this way. Other provider surfaces do not set this timeout. The timeout and retry behaviour is tested in `test/bedrock-provider.test.ts` (the per-call timeout case, which asserts only the essay scorer sets one). AI short answers reach the same scorer with `kind: "short_answer"`, which selects a different system prompt (`SHORT_ANSWER_SCORE_SYSTEM_PROMPT` in `scoreCore.ts`); they share this timeout and retry behaviour ([batch and per-essay AI scoring](scoring-and-results.md#batch-and-per-essay-ai-scoring)).

Adding a vendor or surface: implement the interface in the surface's `types.ts`, add a branch to the selector, keep `mock` as the default, document the env var, and add a test beside `bedrock-provider.test.ts` / `anthropic-provider.test.ts` that stubs the SDK. Real-provider smoke scripts exist (`scripts/bedrock-smoke.ts`, `scripts/guardrail-smoke.ts`) but are conditional manual checks needing AWS credentials, not part of ordinary validation.

## Guardrail wrapper (ADR 0012)

`runGuarded` (`lib/safeguarding/guard.ts`) wraps an AI call with a pre-check and a post-check against the configured `GuardrailProvider` and records every check in `guardrail_events`. Telemetry persists only a snippet of at most 500 characters, strips `detail` from findings that could hold the matched text (`pii`, `blocked_word`), and replaces the snippet entirely when a PII finding fired. Blocked-word snippets are kept on purpose because the term is operator-configured and triage needs the context. `runGuarded` takes `inputMode: "enforce" | "record"`. Essay scoring (`aiScoreResponse.ts`) uses `"record"`: the input check still runs and a hit is stored as action `flag`, but the model is called anyway, because the student's own essay is what the teacher reads. Only the output check can block an essay score. A literary essay that discusses mature themes had been refused by the input check in a 2026-09-25 pilot report. PDF import (`app/api/assessments/[id]/items/import-pdf/route.ts`) also uses `"record"` since 2026-10-25, because the guardrail's PROMPT_ATTACK filter refused ordinary test directions; there the output check screens the whole proposal, and the prompt fences the document as data ([PDF import](pdf-import.md#pipeline)). The wrapper is called by the item-generation routes, the math translator action, PDF import, rubric extraction, [standards suggestion](standards-alignment.md#suggest-standards), AI essay scoring (`aiScoreResponse.ts`) and the class-insights report and chat routes; `guardrail_events` rows are swept after 90 days ([deployment and observability](../operations/deployment-and-observability.md#retention-sweep)).

## Hand-in screening and alerts

```mermaid
sequenceDiagram
    participant S as submit route
    participant X as screenResponse
    participant M as Screener
    participant G as Guardrail
    participant DB as safeguarding_alerts
    participant E as Email
    S-->>X: schedule after response
    X->>M: essay and short_text answers
    X->>G: prompt attack check
    X->>DB: wellbeing or prompt_injection row
    X->>E: notify staff
    Note over X: failure leaves safeguarding_screened_at null
```

Screening after hand-in. The submit response never waits for it.

- `scheduleAttemptScreening` (`lib/safeguarding/screening/screen.ts`) uses Next's `after()` so the hand-in response is sent first. It screens only `essay` and `short_text` responses that are unscreened or edited after their last screening (`safeguarding_screened_at < updated_at`).
- Two alert kinds in `safeguarding_alerts`: `wellbeing` (the screener names any non-`none` category, with no confidence threshold) and `prompt_injection` (the screener's injection half **or** the guardrail's PROMPT_ATTACK filter, because they miss different things).
- A prompt-injection alert withholds AI scoring for that answer. `injectionAlertFor` (`lib/safeguarding/alerts.ts`) finds it; acknowledging does not release the score, only an explicit "Score with AI anyway" (`ai_forced_at`) does. Even a forced score is written as a proposal, never a final, when the item uses Hybrid, so a teacher reviews that answer ([Hybrid and unreviewed AI scores](scoring-and-results.md#hybrid-and-unreviewed-ai-scores)). The Google Docs release also skips students with open alerts (see [integrations](integrations.md#google-docs-release)).
- Retry: `register()` in `instrumentation.ts` calls `startScreeningRetry` (`screening/retry.ts`), an hourly in-app timer (`RETRY_INTERVAL_MS`) over hand-ins from the last 14 days, 200 per run, after a 10-minute grace. It lives in the app and not the roster Lambda because the Lambda sits in isolated subnets with no route to Bedrock. Lazy screening also happens just before a teacher's Score with AI, whether for one essay or for a whole section ([batch and per-essay AI scoring](scoring-and-results.md#batch-and-per-essay-ai-scoring)).
- Surfaces: `app/api/admin/safeguarding-alerts`, `app/api/assessments/[id]/safeguarding-alerts`, `app/api/safeguarding-alerts/[alertId]/acknowledge`, pages `app/admin/safeguarding` and the per-assessment alert views; staff email via `lib/email/safeguardingNotifications.ts`. The design note is `docs/safeguarding-alerts-design.md`.

## Change navigation

- Start at the selector for the surface, then its `*Core.ts`. Keep prompts and validators in the core file so mock and real providers cannot diverge.
- Anything that sends student text to a model must go through `runGuarded` and must not log the text (`lib/log.ts` redaction contract).
- Tests: `safeguarding.test.ts` (guard and telemetry), `safeguarding-screening.test.ts` (screen, retry, dedupe), `safeguarding-route.test.ts`, `safeguarding-alerts-ui.test.tsx`, `essay-scorer.test.ts`, `ai-generate*.test.ts`, `math-translator.test.ts`, `math-normalize.test.ts`, `pdf-extract.test.ts`. DB-backed ones need the `_test` database ([testing](../testing/testing-and-validation.md)).
- Escalate to a broader review when a change alters which student text leaves the app, adds a new vendor, or changes alert semantics. Those carry privacy and DPA implications recorded in ADR 0012 and 0014.
