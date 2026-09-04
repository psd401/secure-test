# 0011. LLM-driven math notation translator

- **Status**: Accepted — Claude Haiku 4.5 wired in Phase 1.5: the direct Anthropic API (2026-05-26), then **Amazon Bedrock** alongside ADR 0007's item generator — Anthropic Bedrock SDK + bearer token (slice 26), corrected to AWS SDK Converse + SigV4 `us.`-inference-profile (slice 27, 2026-06-15). Mock remains the default; set `MATH_TRANSLATOR_PROVIDER=anthropic|bedrock` to use a real model.
- **Date**: 2026-05-21; Phase 1.5 direct-API wiring 2026-05-26; Bedrock wiring (slice 26) + Converse/SigV4 correction (slice 27) 2026-06-15

## Context

Teachers entering math into stems and choices currently type raw LaTeX — `$\frac{1}{2}$`, `$x^2$`, `$\sqrt{n}$`, etc. That's a learning curve K-12 teachers shouldn't have to climb just to write a fraction. Slice 11 added live KaTeX rendering of whatever the teacher types; this slice adds an LLM-driven translator that turns "one half plus one third" into `\frac{1}{2}+\frac{1}{3}` so the teacher never has to learn LaTeX syntax to use math notation.

## Decision

A small, separate provider abstraction (`design-tool/lib/ai/mathTranslator/`) parallel to slice 7's `ItemGeneratorProvider`. Separate intentionally:

- **Different gating**. The slice-7 item generator is gated by `assessments.allow_llm_authoring` because generating an item wholesale is "AI authoring." Translating notation isn't authoring — it's a converter. Per the slice-18 conversation: always-on, no per-assessment toggle.
- **Different request / response shape**. Item generation takes `{ assessment_id, item_type, prompt }` and returns a full `CreateItemBody`. Math translation takes `{ prompt, display_mode }` and returns just a LaTeX string (without `$` delimiters; the caller decides display mode at insertion time).
- **Different model fit**. Item generation benefits from a stronger model (Sonnet recommended). Math translation is well within Haiku's capability envelope at much lower latency / cost.

Today the abstraction ships with one implementation: `mockMathTranslator`. It does pattern-matching on common K-12 phrasings (fractions, exponents, square roots, the four operator words, `\degree` / `\percent` via existing macros) and falls through to `[TRANSLATE-MOCK: …]` for anything it can't recognize — better signal than a silent wrong answer.

The selector is env-driven (`MATH_TRANSLATOR_PROVIDER`, defaults to `mock`). Adding a real provider is a one-file change.

## Recommendation when wiring real

Per the model-trade-off matrix in ADR 0007: **Claude Haiku 4.5** is the right pick for this surface.

- **Latency**: 500 ms–1 s per round-trip for ~50 input + ~50 output tokens. Acceptable for a button-driven flow.
- **Cost**: trivial at school-district volume (~$0.80/M input, ~$4/M output as of mid-2026 pricing). Hundreds of conversions per day cost cents.
- **Capability**: math-LaTeX conversion is well-trodden territory. Haiku handles "x squared minus 3" → `x^2 - 3` reliably.
- **Structured output**: enforce a strict response shape (`{ latex, confidence }`) via Anthropic's structured-output mode so a malformed reply doesn't smuggle non-LaTeX into the editor.

Open questions (carried over from ADR 0007):
- 11.1 Same Anthropic key as the item generator, or separate?
- 11.2 Real provider implementation lives in `lib/ai/mathTranslator/anthropicHaikuProvider.ts` — confirm the file layout before wiring.

## Amazon Bedrock wiring (Phase 1.5, corrected in slice 27)

Mirrors ADR 0007's corrected Bedrock decision: PSD's production path is Claude Haiku 4.5 on Amazon Bedrock (us-west-2). The direct `anthropic` translator stays wired alongside it; the mock stays the default. Resolves open questions 11.1 (same Bedrock account as the item generator) and 11.2 (file layout — `bedrockProvider.ts` next to `anthropicProvider.ts`).

As with the item generator, the first wiring (slice 26: `@anthropic-ai/bedrock-sdk` + bearer token) was corrected in slice 27 to the AWS SDK Converse + SigV4 path, emulating the social-stories project. (Haiku 4.5 *was* reachable via the bearer/Mantle endpoint, but both providers now share one auth path.)

- **SDK / client**: `@aws-sdk/client-bedrock-runtime` → `BedrockRuntimeClient` + `ConverseCommand`, via the shared `lib/ai/bedrockConverse.ts` (`converseText`). The system prompt and LaTeX clean-up stay shared with the direct translator through `lib/ai/mathTranslator/mathCore.ts` (`MATH_SYSTEM_PROMPT`, `finalizeLatex`).
- **Model id**: default `us.anthropic.claude-haiku-4-5-20251001-v1:0` (the `us.` cross-region inference profile — Haiku 4.5 carries a date+version suffix on Bedrock, unlike Sonnet 4.6's bare `us.anthropic.claude-sonnet-4-6`; confirmed via `aws bedrock list-inference-profiles`). Override via `BEDROCK_MATH_MODEL`. `temperature` 0 keeps the conversion deterministic. Plain Converse text (no tool needed for single-string LaTeX output).
- **Region / auth**: identical posture to ADR 0007 — `AWS_REGION` defaults to us-west-2; SigV4 credentials resolve through the AWS chain (profile/keys/SSO local, IAM role deployed); no env pre-check.
- **Env vars** to add to `.env.local` / `.env.local.example` (region + AWS credentials are shared with the item provider):
  ```
  MATH_TRANSLATOR_PROVIDER=bedrock
  # BEDROCK_MATH_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0   # optional override
  ```
- **Verification**: mocked-SDK unit tests in `test/bedrock-provider.test.ts` (no AWS needed). Live validation via `scripts/bedrock-smoke.ts`, gated on local AWS credentials with `InvokeModel` access to the Haiku `us.` profile.

## Consequences

- **Better**: teachers without LaTeX fluency can author math items by describing the expression in plain English. The mock provider keeps the UX fully testable without an API key or cost commitment.
- **Worse**: the mock provider's pattern matcher is intentionally narrow — anything beyond the recognized K-12 phrasings echoes back with a clear "mock didn't understand" prefix. That makes the mock obviously a mock (good) but also means slightly more rough edges in dev / demo than a real model would show.
- **Escape hatch**: if the LLM proves unreliable for math conversion in practice, the panel is small enough to retire without touching anything else. The teacher can always type LaTeX directly into the textarea — the translator is additive.

## TODO

- [x] **11.A Wire Haiku** — done. Direct Anthropic API (2026-05-26) and Amazon Bedrock (slice 26) translators wired; mock stays the default. See the Bedrock wiring section above. (Structured-output mode was not adopted; the translator strips `$`/fence noise and rejects empty output instead.)
- [ ] **11.B Voice input** (Whisper / browser SpeechRecognition) so a teacher can dictate the expression instead of typing. Doesn't need a real model upgrade — same translator path; just a different input.
- [ ] **11.C Image input** (vision model) so a teacher can snap a photo of handwritten math from an iPad and get it converted. This is the multimodal use case that pushes us toward Sonnet (vision) or Gemini, not Haiku.
