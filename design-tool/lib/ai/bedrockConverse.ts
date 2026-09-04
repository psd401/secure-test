import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type Tool,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

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

// Plain-text Converse turn — used by the math translator (text in, LaTeX out)
// and the PDF extractor. An optional PDF document block can precede the text
// (ADR 0015: Claude reads scanned pages directly; no local rasterization).
export async function converseText(opts: {
  modelId: string;
  systemText: string;
  userText: string;
  maxTokens: number;
  temperature?: number;
  document?: { bytes: Uint8Array; name: string };
  errPrefix: string;
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
  document?: { bytes: Uint8Array; name: string };
  errPrefix: string;
}): Promise<{ text: string; stopReason: string | undefined }> {
  const content: ContentBlock[] = [];
  if (opts.document) {
    content.push({
      document: {
        format: "pdf",
        name: sanitizeDocumentName(opts.document.name),
        source: { bytes: opts.document.bytes },
      },
    });
  }
  content.push({ text: opts.userText });
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
}): Promise<Record<string, unknown>> {
  const toolName = opts.tool.toolSpec?.name;
  const toolConfig: ToolConfiguration = {
    tools: [opts.tool],
    ...(toolName ? { toolChoice: { tool: { name: toolName } } } : {}),
  };
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
  const toolUse = response.output?.message?.content?.find((b) => b.toolUse)
    ?.toolUse;
  if (!toolUse?.input) {
    throw new Error(`${opts.errPrefix}_returned_no_tool_use`);
  }
  return toolUse.input as Record<string, unknown>;
}
