# 0012. Safeguarding — guardrail abstraction, mock-default, Bedrock-ready

- **Status**: Accepted + **live-validated 2026-06-16** — guardrail `<guardrail-id>` version 1 (us-west-2, account <account-id>), VIOLENCE content filter confirmed blocking via `scripts/guardrail-smoke.ts`. Default stays `off`; enable per app via `.env.local`. Admin review UI (slice 30) **tabled** pending ClassLink role claims.
- **Date**: 2026-06-16

## Context

Item generation (Claude Sonnet 4.6) and the math translator (Claude Haiku 4.5) now make live calls to Amazon Bedrock (ADRs 0007 / 0011, slices 25–27). There is no governance layer around that model I/O. The broader plan calls for a safeguarding + reporting module (`design-tool-plan.md` Phase 2), built on AWS Bedrock Guardrails, most load-bearing once Phase 3 surfaces model-generated feedback to students.

Both current AI surfaces are teacher-facing and teacher-reviewed, so this is defense-in-depth and an early telemetry baseline, not a live-exposed hole. The same abstraction-first pattern resolved cleanly for AI providers (0007), the math translator (0011), and storage (0008): a thin interface, a mock-default implementation that keeps everything testable without the cloud dependency, and a documented swap path.

## Decision

- `design-tool/lib/safeguarding/` defines a `GuardrailProvider` interface (`check(text, { stage, surface }) → { action, findings }`), parallel to `ItemGeneratorProvider`.
- **Default is off, not mock.** `getGuardrailProvider()` is env-keyed off `GUARDRAIL_PROVIDER` (default `off` → `null`). A null provider makes the wrapper a zero-overhead pass-through that writes no telemetry, so existing behavior and the existing test suite are unchanged until a guardrail is deliberately enabled. `mock` is a deterministic pattern matcher for tests / local demo; `bedrock` is the real provider.
- **Standalone ApplyGuardrail, not inline Converse `guardrailConfig`.** The real provider (`bedrockGuardrail`) calls the Bedrock `ApplyGuardrail` API as a separate request. Rationale:
  - Provider-agnostic: the same check runs over the mock / anthropic / bedrock AI providers' output, not just the Bedrock model call.
  - Clean separation of the input check (before the model, so a blocked input skips the paid model call) and the output check (after), each recorded individually.
  - Inline `guardrailConfig` only covers the Bedrock path and couples the guardrail to the model invocation.
  - Trade-off: two extra Bedrock calls (input + output) per AI request. Acceptable for a button-driven authoring flow; revisit if it shows up in latency/cost.
- **Wrapper.** `runGuarded()` (`lib/safeguarding/guard.ts`) runs input-check → model → output-check, records every check to `guardrail_events`, and on a block returns a discriminated `{ ok: false, stage, findings }`. Telemetry-write failures are logged and swallowed — they never break item generation.
- **Hard-fail with a user note on block** (per the slice decision). Item gen returns HTTP 422 `guardrail_blocked` with `stage`, `findings`, and a human-readable `note`; the math action returns `{ ok: false, error: "guardrail_blocked", note }`. Masking/anonymizing the output instead of failing is a future option, not v1.
- **Both surfaces are guarded** (item gen + math translate). Math is low-risk (text → LaTeX) but included for telemetry completeness.
- **Telemetry.** `guardrail_events` (one row per check: `surface`, `stage`, `action`, `provider_id`, `findings` jsonb, truncated `text_snippet`, `owner_sub`). CHECK constraints pin the enums. The full prompt/response is never stored — only a ≤500-char snippet.
- Region / credentials share ADR 0007's posture (`AWS_REGION` default us-west-2; SigV4 via the AWS chain; the `bedrockClient()` + `wrapBedrockError()` helpers are reused).

## Consequences

- **Better**: the entire safeguarding path — wrapper decision logic, telemetry persistence, the route's 422 behavior, and the Bedrock provider's request/response mapping — is testable today (`bun test`, mocked SDK + injected recorder, no AWS). Turning on real protection is a config change (`GUARDRAIL_PROVIDER=bedrock` + `GUARDRAIL_ID`) once a guardrail is provisioned.
- **Worse**: the mock guardrail's matcher is intentionally narrow (a sentinel token, an SSN shape, a tiny blocked-word list); it does not exercise the failure modes a real guardrail will. Findings mapping from the verbose Bedrock assessment is best-effort — a blocked verdict always carries at least a `guardrail_intervened` fallback finding, but niche policies may not be itemized.
- **Escape hatch**: `GUARDRAIL_PROVIDER=off` instantly removes the layer with no code change.

## TODO: before enabling `bedrock` in production

- [x] **12.1 Guardrail policy config.** Done — a conservative guardrail was provisioned (content filters incl. VIOLENCE confirmed blocking; PII action = BLOCK, matching the hard-fail decision). Tune further in the console as needed.
- [ ] **12.2 Provisioning path.** Created via the **AWS console** for the first guardrail. Capturing it as CDK (reproducible — AI Studio's `guardrails-stack` precedent) is still open.
- [x] **12.3 Version strategy.** Done — published **version 1**, pinned via `GUARDRAIL_VERSION=1`. `DRAFT` remains available for dev iteration.
- [x] **12.4 IAM.** Done — `secure-test-bedrock` has inline policy `bedrock-apply-guardrail`: `bedrock:ApplyGuardrail` on `arn:aws:bedrock:us-west-2:<account-id>:guardrail/*` (wildcarded for future guardrails).
- [ ] **12.5 Cost / latency budget.** Confirm two ApplyGuardrail calls per AI request is acceptable, or gate which surfaces/stages are checked.

### Wiring status

- [x] Abstraction + mock + `guardrail_events` table/migration + `runGuarded` wrapper + both call sites (slice 28).
- [x] `bedrockGuardrail` via `ApplyGuardrail` + `GUARDRAIL_PROVIDER=bedrock` selector + mocked-SDK tests (slice 29).
- [x] Provision the guardrail in AWS (12.1, 12.3, 12.4) and live-validate via `bun scripts/guardrail-smoke.ts` — done 2026-06-16 (benign → allow; violence prompt → block, `content_filter/VIOLENCE`).
- [ ] **Add `GUARDRAIL_PROVIDER=off` (+ commented `GUARDRAIL_ID` / `GUARDRAIL_VERSION`) to `.env.local.example`** — pending (the file is outside the agent's write permissions; add manually).
- [ ] Set `GUARDRAIL_PROVIDER=bedrock` / `GUARDRAIL_ID=<guardrail-id>` / `GUARDRAIL_VERSION=1` in each app's `.env.local` to actually enforce (default stays `off`).
- [ ] Admin review page `/dashboard/admin/safeguarding` (slice 30) — **tabled** until ClassLink supplies the `classLink_role` claim (no admin gate exists yet), or a dev `ADMIN_SUBS` allowlist is added.
