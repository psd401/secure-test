# 0007. AI model selection for item generation

- **Status**: Accepted — Claude Sonnet 4.6 wired in Phase 1.5: the direct Anthropic API (2026-05-26), then **Amazon Bedrock** — first via the Anthropic Bedrock SDK + bearer token (slices 25/26), corrected after live testing to the AWS SDK Converse + SigV4 `us.`-inference-profile path (slice 27, 2026-06-15), emulating the social-stories project. Provider abstraction retained for future model swaps. Mock remains the default for tests/CI.
- **Date**: 2026-05-21; Phase 1.5 direct-API wiring 2026-05-26; Bedrock wiring (slices 25/26) + Converse/SigV4 correction (slice 27) 2026-06-15

## Context

Slice 7 added the AI-assisted item authoring surface — a Generate-with-AI panel in the editor, a `POST /api/ai/generate-item` route, and an `ItemGeneratorProvider` abstraction (`lib/ai/`). Today the only implementation is `mockProvider`, which returns deterministic-ish placeholder items so the entire UX can be exercised without an API key.

Picking the production model (and its API key + cost / privacy posture) is intentionally **deferred**. James is partial to Claude Sonnet for tasks like this, but it's unclear whether item authoring will need multimodal capability (image input, or image-generating items). This ADR captures the trade-offs so a later "wire up the real model" decision can be made deliberately.

## Decision

- The provider abstraction lives at `design-tool/lib/ai/provider.ts` and is keyed off the `AI_PROVIDER` env var. The default is `mock`; any other value throws an error pointing at this ADR. To add a real provider, implement `ItemGeneratorProvider` in `lib/ai/<name>Provider.ts`, then extend `getProvider()` to recognize the new key.
- No specific model, SDK, or API key is bound in this slice.
- The route validates every provider's output through `CreateItemBody.safeParse` so a misbehaving model can't smuggle a malformed item past the human review step.

## Model trade-off matrix (as of 2026-05)

| Model | Strengths for item authoring | Trade-offs | When it fits |
|---|---|---|---|
| **Claude Sonnet 4.6** | Strong reasoning. Excellent at structured / JSON-mode output. Solid vision input. Mid-cost, mid-latency. | No native image generation. Slightly behind Opus on subtle pedagogy nuance. | **Default recommendation** for text-only MC + short-text item authoring and rubric scoring. |
| **Claude Opus 4.7** | Highest reasoning quality of the Claude family. Best for pedagogically nuanced or domain-expert items. | Slow, expensive. Overkill for batch / trivial item rephrasing. | One-off high-value items, complex domain content (multi-step science, advanced math reasoning). |
| **Claude Haiku 4.5** | Fast, cheap. Good enough for low-stakes batch generation, rephrasing, distractor enumeration. | Weaker on pedagogy and subtle wording. | Bulk distractor generation; reword-this-question; cheap A/B comparisons. |
| **GPT-5.1 / GPT-5.1-mini** | Strong general capability. OpenAI ecosystem has a separate native image-generation endpoint usable from the same SDK. | Different SDK + auth; PSD would manage two vendor relationships. | Items that need *generated* images (charts, diagrams) when the model itself is the source of truth. |
| **Gemini 3.0 Pro / Flash** | Google's strongest multimodal model. Native image generation. Very long context. | Different SDK + auth; output quality varies on K-12 pedagogy compared with Sonnet. | Image-heavy items (graphics-in-stem) where Gemini's native generator is in the loop. |
| **Grok 4.1** | Reasoning competitive with Sonnet on STEM. xAI ecosystem. | Less mature structured-output tooling; fewer K-12-specific examples in training. | Backup option if PSD already has xAI access; not a default. |

## Recommendation matrix (when the decision lands)

- **Text-only items (MC, short text, essay rubrics)**: Claude **Sonnet** as the default. Haiku as a cheap fallback for batch.
- **Items that need a *generated* image** (chart, diagram, hot-spot graphic): **Gemini 3 Pro** or **GPT-5.1's image endpoint** — not Claude (Claude reasons about images well but doesn't generate them).
- **Items where a teacher uploads an image and the model writes a question about it**: any vision-capable Claude model works; **Sonnet** is the right default.
- **Rubric grading (Phase 3 of the broader plan)**: **Sonnet** with structured-output mode; Opus only if the rubric is unusually subtle.

## TODO: before wiring a real provider

Resolve these in order, then proceed with the wiring steps below.

- [ ] **7.1 API key + billing source.** Does PSD already have an Anthropic API key + billing? (Broader-plan Q 1.3.) If yes, default to Sonnet and skip vendor procurement.
- [ ] **7.2 Multimodal need.** Does the MVP need image-generating items? If no, Sonnet alone covers everything and we avoid managing a second vendor.
- [ ] **7.3 Data residency / PII.** Item *stems* may include scenario text containing student-identifying details. Verify the chosen vendor's training-data and retention policy against PSD's privacy posture.
- [ ] **7.4 Streaming.** Nice-to-have UX but adds SSE / WebSocket complexity to the API and the editor. Defer unless latency feels bad with the real model.
- [ ] **7.5 Usage caps.** Per-teacher / per-assessment cost containment matters once a real provider is wired.

### Wiring steps (after the questions above are answered)

- [ ] Implement `ItemGeneratorProvider` in `design-tool/lib/ai/<name>Provider.ts` (e.g. `sonnetProvider.ts`).
- [ ] Extend `getProvider()` in `design-tool/lib/ai/provider.ts` to recognize the new `AI_PROVIDER` value and return the new impl.
- [ ] Add the vendor SDK to `design-tool/package.json` (e.g. `@anthropic-ai/sdk`) and `bun install`.
- [ ] Add `AI_PROVIDER=<name>` + the vendor API key to the runtime env (and to `.env.local.example` as a documented but unset placeholder).
- [ ] Add an integration test exercising the new provider against a recorded fixture or the vendor's testing endpoint (do **not** hit the live API from CI by default).
- [ ] Verify the editor's Generate-with-AI panel returns a real model proposal on a known-enabled assessment; update ADR 0007's `Status:` line to record the resolution.

## Amazon Bedrock wiring (Phase 1.5, corrected in slice 27)

PSD's production path is Claude on **Amazon Bedrock** (us-west-2), chosen over the direct Anthropic API and Claude Platform on AWS. The direct `anthropic` provider stays wired alongside it; the mock stays the CI/test default. This resolves TODO 7.1 (API key / billing source → Bedrock).

The wiring **emulates the proven pattern in the social-stories project** (`/code/social-stories`). Live testing showed the first attempt (slices 25/26: `@anthropic-ai/bedrock-sdk` + a bearer token + `global.anthropic.*` ids) only reached Haiku 4.5 on the `bedrock-mantle` Messages endpoint — Sonnet 4.6 is served via **SigV4 `InvokeModel`/Converse**, not the bearer/Mantle path. Slice 27 reworked the Bedrock providers accordingly.

- **SDK / client**: `@aws-sdk/client-bedrock-runtime` → `BedrockRuntimeClient` + `ConverseCommand` (`lib/ai/bedrockConverse.ts`). Replaced the bearer-only `@anthropic-ai/bedrock-sdk`.
- **Auth: SigV4 (IAM), not a bearer token.** Credentials resolve through the standard AWS chain — local dev: an AWS profile/SSO or access keys; deployed (post slice-24 infra): the Lambda/task execution **role**. The account needs a foundation-model agreement for the model and `bedrock:InvokeModel` on both the model and inference-profile ARNs — the IAM policy social-stories' `backend.ts` grants: `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6` and `arn:aws:bedrock:*:<account>:inference-profile/us.anthropic.claude-sonnet-4-6`.
- **Model ids**: the **`us.` cross-region inference profiles** —
  - Item-gen default: `us.anthropic.claude-sonnet-4-6` (override via `BEDROCK_ITEM_MODEL`).
  - Math translator: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (override via `BEDROCK_MATH_MODEL`). Note Haiku 4.5 carries a date+version suffix on Bedrock; Sonnet 4.6's profile id is bare.
  - The `global.`-prefixed / version-suffixed forms 404 against this account; `us.` is the working profile.
- **Region**: `AWS_REGION` (defaults to `us-west-2`).
- **Structured output**: item generation uses a **forced Converse tool** (`emit_item`) for reliable JSON, with a tolerant normalizer (Claude occasionally stringifies a nested array). The route's `CreateItemBody.safeParse` is still the final gate. The math translator uses plain Converse text + the existing LaTeX strip.
- **Shared code**: the item/math system prompts and the math LaTeX strip stay shared (`itemGenCore` / `mathCore`); the Converse call + error wrap live in `lib/ai/bedrockConverse.ts`. The direct-Anthropic providers keep using `@anthropic-ai/sdk` + the `messages.create` core unchanged.
- **Env vars** to add to `.env.local` / `.env.local.example` (AWS creds via profile/keys/SSO — no bearer token):
  ```
  AI_PROVIDER=bedrock
  MATH_TRANSLATOR_PROVIDER=bedrock
  AWS_REGION=us-west-2
  AWS_PROFILE=<profile-with-bedrock-access>   # or AWS_ACCESS_KEY_ID/SECRET, or an IAM role when deployed
  # BEDROCK_ITEM_MODEL=us.anthropic.claude-sonnet-4-6   # optional override
  # BEDROCK_MATH_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0   # optional override
  ```
- **Verification**: mocked-SDK unit tests in `test/bedrock-provider.test.ts` (no AWS needed). Live validation via `scripts/bedrock-smoke.ts`, gated on local AWS credentials with `InvokeModel` access to the Sonnet/Haiku `us.` profiles.

## Consequences

- **Better**: the entire AI UX is functional today (mock provider). Tests cover the route guards, ownership, and `allow_llm_authoring` gate. When the model decision is made, the change is one file (`lib/ai/<name>Provider.ts`) plus an env var.
- **Worse**: the mock provider's outputs aren't pedagogically useful — teachers will see placeholder choices labelled "Option A — drafted by AI; review before saving." This is intentional: it makes it obvious the proposal needs human review and prevents anyone shipping a real assessment built entirely from mock output.
- **Escape hatch**: if a real provider lands and proves unfit, swapping back to `mock` is a one-line env-var change.
