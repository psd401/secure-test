import { getGuardrailProvider } from "./provider";
import { recordGuardrailEvent, type RecordGuardrailEvent } from "./telemetry";
import type {
  GuardrailFinding,
  GuardrailProvider,
  GuardrailStage,
  GuardrailSurface,
} from "./types";

// Cap on how much of the checked text we persist for triage. The full
// prompt/response is never stored.
const SNIPPET_MAX = 500;

function snippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

/**
 * Finding types whose `detail` could carry the matched substring itself rather
 * than a policy label, and must therefore have it stripped. See the
 * GuardrailFinding docs in ./types.
 *
 * `blocked_word` is here because Bedrock's word policy reports only `match` —
 * unlike PII entities, it exposes no category to substitute — so the provider
 * has nothing safe to put in `detail` and omits it. This set is the
 * belt-and-braces backstop for that.
 */
const MATCH_BEARING_FINDING_TYPES = new Set(["pii", "blocked_word"]);

/**
 * Finding types where the CHECKED TEXT ITSELF is too sensitive to persist.
 *
 * Deliberately narrower than MATCH_BEARING_FINDING_TYPES: these are two
 * different concerns and were previously conflated in one set. A PII block
 * means the text contains PII, so persisting a 500-char window of it defeats
 * the filter. A blocked-word block means the text contains a term the district
 * put on its own denylist — suppressing the snippet there would destroy the
 * triage context an admin needs without protecting anything, since the term is
 * one the operator configured, not data about a person.
 */
const SNIPPET_SUPPRESSING_FINDING_TYPES = new Set(["pii"]);

/**
 * Placeholder stored instead of the checked text when a snippet-suppressing
 * finding fired.
 */
const REDACTED_SNIPPET = "[redacted — sensitive finding]";

/**
 * Drop `detail` on a sensitive finding when it is the matched substring rather
 * than a category label.
 *
 * The test is provider-agnostic and needs no assumption about label format: a
 * match value is by definition a substring of the text that was checked, while
 * a category label ("US_SOCIAL_SECURITY_NUMBER", "ssn_shape") is not. So if the
 * detail appears verbatim in the checked text, it is a match — strip it. A
 * provider that regresses to emitting `match` therefore cannot leak it into
 * telemetry or the 422 body even though the provider-side fix is the primary
 * control.
 */
function redactFindings(
  findings: GuardrailFinding[],
  checkedText: string,
): GuardrailFinding[] {
  const haystack = checkedText.toLowerCase();
  return findings.map((f) => {
    if (!MATCH_BEARING_FINDING_TYPES.has(f.type)) return f;
    if (f.detail === undefined) return f;
    if (!haystack.includes(f.detail.toLowerCase())) return f;
    return { type: f.type };
  });
}

function hasSnippetSuppressingFinding(findings: GuardrailFinding[]): boolean {
  return findings.some((f) => SNIPPET_SUPPRESSING_FINDING_TYPES.has(f.type));
}

/**
 * Snippet to persist: suppressed entirely when the checked text itself is too
 * sensitive to store (see SNIPPET_SUPPRESSING_FINDING_TYPES).
 */
function snippetFor(text: string, findings: GuardrailFinding[]): string {
  return hasSnippetSuppressingFinding(findings)
    ? REDACTED_SNIPPET
    : snippet(text);
}

export type GuardedOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; stage: GuardrailStage; findings: GuardrailFinding[] };

export interface RunGuardedOpts<T> {
  surface: GuardrailSurface;
  ownerSub: string;
  /**
   * Text checked BEFORE the model runs (the user's prompt). Omit to skip
   * the input stage entirely — only for surfaces where no pre-model text
   * exists (scanned-PDF OCR reads raw PDF bytes; ADR 0015). The output
   * stage always runs.
   */
  inputText?: string;
  /** Invokes the AI provider. Skipped entirely if the input is blocked. */
  run: () => Promise<T>;
  /** Extracts the text to check from the model's result. */
  outputText: (result: T) => string;
}

export interface RunGuardedDeps {
  provider?: GuardrailProvider | null;
  record?: RecordGuardrailEvent;
}

// Telemetry must never break item generation: a failed insert is logged
// and swallowed, not propagated.
async function safeRecord(
  record: RecordGuardrailEvent,
  e: Parameters<RecordGuardrailEvent>[0],
): Promise<void> {
  try {
    await record(e);
  } catch (err) {
    console.error("guardrail telemetry write failed", err);
  }
}

/**
 * Run an AI call wrapped in pre- and post-guardrail checks.
 *
 * - Provider `null` (GUARDRAIL_PROVIDER=off, the default): runs the call
 *   directly, no checks, no telemetry — zero overhead.
 * - Input blocked: the model is NOT called (saves cost); returns a
 *   stage:"input" block.
 * - Output blocked: returns a stage:"output" block.
 * - Every check performed is recorded (allow or block).
 */
export async function runGuarded<T>(
  opts: RunGuardedOpts<T>,
  deps: RunGuardedDeps = {},
): Promise<GuardedOutcome<T>> {
  const provider =
    deps.provider !== undefined ? deps.provider : getGuardrailProvider();
  if (!provider) {
    return { ok: true, result: await opts.run() };
  }
  const record = deps.record ?? recordGuardrailEvent;

  if (opts.inputText !== undefined) {
    const inputVerdict = await provider.check(opts.inputText, {
      stage: "input",
      surface: opts.surface,
    });
    const inputFindings = redactFindings(inputVerdict.findings, opts.inputText);
    await safeRecord(record, {
      owner_sub: opts.ownerSub,
      surface: opts.surface,
      stage: "input",
      action: inputVerdict.action,
      provider_id: provider.id,
      findings: inputFindings,
      text_snippet: snippetFor(opts.inputText, inputFindings),
    });
    if (inputVerdict.action === "block") {
      return { ok: false, stage: "input", findings: inputFindings };
    }
  }

  const result = await opts.run();

  const outText = opts.outputText(result);
  const outputVerdict = await provider.check(outText, {
    stage: "output",
    surface: opts.surface,
  });
  const outputFindings = redactFindings(outputVerdict.findings, outText);
  await safeRecord(record, {
    owner_sub: opts.ownerSub,
    surface: opts.surface,
    stage: "output",
    action: outputVerdict.action,
    provider_id: provider.id,
    findings: outputFindings,
    text_snippet: snippetFor(outText, outputFindings),
  });
  if (outputVerdict.action === "block") {
    return { ok: false, stage: "output", findings: outputFindings };
  }

  return { ok: true, result };
}
