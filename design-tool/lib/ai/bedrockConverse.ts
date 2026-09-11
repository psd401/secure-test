import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type DocumentFormat,
  type Tool,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { log } from "@/lib/log";

// Amazon Bedrock access via the AWS SDK's Converse API + SigV4, emulating the
// proven pattern in the social-stories project (see ADR 0007). Claude Sonnet
// 4.6 / Haiku 4.5 are reached through the `us.anthropic.*` cross-region
// inference profiles in us-west-2; auth is SigV4 (no bearer token), so the
// account needs a foundation-model agreement for the model and the caller
// needs `bedrock:InvokeModel` on the model + inference-profile ARNs.

const DEFAULT_REGION = "us-west-2";

let cachedClient: BedrockRuntimeClient | null = null;
export function bedrockClient(): BedrockRuntimeClient {
  if (cachedClient) return cachedClient;
  // Credentials resolve through the standard AWS chain (env keys, AWS_PROFILE,
  // SSO, or an IAM role when deployed) — there is no env pre-check because the
  // IAM-role path sets none of the credential env vars. Missing-credential and
  // access failures surface at call time and are wrapped by wrapBedrockError.
  cachedClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || DEFAULT_REGION,
  });
  return cachedClient;
}

// AWS SDK service errors carry `$metadata.httpStatusCode` and a `name` ending
// in "Exception". Wrap to the same bedrock_api_error_<status> shape the rest of
// the AI layer uses; any other throwable is rethrown unchanged.
export function wrapBedrockError(err: unknown, errPrefix: string): never {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  const name = (err as { name?: unknown })?.name;
  const message = (err as { message?: unknown })?.message;
  if (status || (typeof name === "string" && name.endsWith("Exception"))) {
    throw new Error(
      `${errPrefix}_api_error_${status ?? "unknown"}: ${
        typeof message === "string" ? message : String(name ?? "unknown")
      }`,
    );
  }
  throw err;
}

function inferenceConfig(maxTokens: number, temperature?: number) {
  return {
    maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

// Bedrock rejects Converse document names containing anything outside
// alphanumerics, single spaces, hyphens, parentheses, and square brackets —
// notably the period, so a real filename like "scan.pdf" fails validation.
// Sanitize here so no caller has to know that rule.
function sanitizeDocumentName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9 \-()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "document";
}

// Document formats Bedrock Converse accepts natively. The rubric extractor
// (docs/rubric-upload-design.md, D-1) sends DOCX as well as PDF, so the
// format is a caller choice; it defaults to "pdf" and the PDF importer is
// untouched.
export type ConverseDocumentFormat =
  | "pdf"
  | "docx"
  | "doc"
  | "md"
  | "txt"
  | "html"
  | "csv"
  | "xlsx";

export interface ConverseDocument {
  bytes: Uint8Array;
  name: string;
  /** Default "pdf" — the only format before the rubric extractor. */
  format?: ConverseDocumentFormat;
}

// Token usage logging (docs/rubric-upload-design.md, D-7). Every AI surface
// that calls Converse — one value per bedrockProvider.ts-style module, not
// per prompt variant within it. Kept here (not derived from
// db/schema.ts's GUARDRAIL_SURFACES) so this file has no dependency on the
// db layer; the values are the same set by convention.
export type ConverseSurface =
  | "item-gen"
  | "math-translate"
  | "pdf-import"
  | "essay-score"
  | "rubric-extract";

// Emits the ai_usage log line (D-7). Never throws — a field read off a
// malformed/missing `usage` becomes null rather than losing the call's
// success. `startedAt` is a `performance.now()` timestamp taken by the
// caller before `send()`.
function logAiUsage(opts: {
  surface: ConverseSurface;
  modelId: string;
  ownerSub: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  startedAt: number;
}): void {
  const usage = opts.usage;
  log.info("ai_usage", {
    surface: opts.surface,
    model: opts.modelId,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    total_tokens: usage?.totalTokens ?? null,
    latency_ms: Math.round(performance.now() - opts.startedAt),
    owner_sub: opts.ownerSub,
  });
}

// Plain-text Converse turn — used by the math translator (text in, LaTeX out)
// and the PDF extractor. An optional PDF document block can precede the text
// (ADR 0015: Claude reads scanned pages directly; no local rasterization).
export async function converseText(opts: {
  modelId: string;
  systemText: string;
  userText: string;
  maxTokens: number;
  temperature?: number;
  document?: ConverseDocument;
  errPrefix: string;
  surface: ConverseSurface;
  ownerSub?: string;
}): Promise<string> {
  return (await converseTextWithMeta(opts)).text;
}

// Same call, plus the turn's stopReason ("max_tokens" when the reply was cut
// off at maxTokens). The PDF extractor uses it to tell a truncated item list
// from genuinely malformed output.
export async function converseTextWithMeta(opts: {
  modelId: string;
  systemText: string;
  userText: string;
  maxTokens: number;
  temperature?: number;
  document?: ConverseDocument;
  errPrefix: string;
  surface: ConverseSurface;
  ownerSub?: string;
}): Promise<{ text: string; stopReason: string | undefined }> {
  const content: ContentBlock[] = [];
  if (opts.document) {
    content.push({
      document: {
        format: (opts.document.format ?? "pdf") as DocumentFormat,
        name: sanitizeDocumentName(opts.document.name),
        source: { bytes: opts.document.bytes },
      },
    });
  }
  content.push({ text: opts.userText });
  const startedAt = performance.now();
  let response: ConverseCommandOutput;
  try {
    response = await bedrockClient().send(
      new ConverseCommand({
        modelId: opts.modelId,
        system: [{ text: opts.systemText }],
        messages: [{ role: "user", content }],
        inferenceConfig: inferenceConfig(opts.maxTokens, opts.temperature),
      }),
    );
  } catch (err) {
    wrapBedrockError(err, opts.errPrefix);
  }
  logAiUsage({
    surface: opts.surface,
    modelId: opts.modelId,
    ownerSub: opts.ownerSub,
    usage: response.usage,
    startedAt,
  });
  const text = response.output?.message?.content?.find((b) => b.text)?.text;
  if (!text) {
    throw new Error(`${opts.errPrefix}_returned_no_text`);
  }
  return { text, stopReason: response.stopReason };
}

// Tool-forced Converse turn — used by item generation for reliable structured
// output. toolChoice pins the named tool; returns its raw input object.
export async function converseTool(opts: {
  modelId: string;
  systemText: string;
  userText: string;
  maxTokens: number;
  temperature?: number;
  tool: Tool;
  errPrefix: string;
  surface: ConverseSurface;
  ownerSub?: string;
}): Promise<Record<string, unknown>> {
  const toolName = opts.tool.toolSpec?.name;
  const toolConfig: ToolConfiguration = {
    tools: [opts.tool],
    ...(toolName ? { toolChoice: { tool: { name: toolName } } } : {}),
  };
  const startedAt = performance.now();
  let response: ConverseCommandOutput;
  try {
    response = await bedrockClient().send(
      new ConverseCommand({
        modelId: opts.modelId,
        system: [{ text: opts.systemText }],
        messages: [{ role: "user", content: [{ text: opts.userText }] }],
        inferenceConfig: inferenceConfig(opts.maxTokens, opts.temperature),
        toolConfig,
      }),
    );
  } catch (err) {
    wrapBedrockError(err, opts.errPrefix);
  }
  logAiUsage({
    surface: opts.surface,
    modelId: opts.modelId,
    ownerSub: opts.ownerSub,
    usage: response.usage,
    startedAt,
  });
  const toolUse = response.output?.message?.content?.find((b) => b.toolUse)
    ?.toolUse;
  if (!toolUse?.input) {
    throw new Error(`${opts.errPrefix}_returned_no_tool_use`);
  }
  return toolUse.input as Record<string, unknown>;
}
