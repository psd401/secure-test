// Generic Messages-API response helpers shared by every Anthropic-family
// provider — direct Anthropic API + Amazon Bedrock — across both item
// generation (itemGenCore) and math translation (mathTranslator/mathCore).
// SDK-agnostic: no import of either client's types or error classes.

// Minimal structural view of a Messages-API content block so these helpers
// accept the response shape from either SDK without importing its types.
type TextBlockish = { type: string; text?: string };

export function extractFirstText(
  content: ReadonlyArray<TextBlockish>,
  errPrefix: string,
): string {
  const block = content.find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  if (!block || typeof block.text !== "string") {
    throw new Error(`${errPrefix}_returned_no_text`);
  }
  return block.text;
}

// Both @anthropic-ai/sdk and @anthropic-ai/bedrock-sdk throw APIError
// instances that carry a numeric `status`. Detect structurally so this one
// helper serves both clients without importing either error class; any other
// throwable (e.g. an AWS credential-resolution error) is rethrown as-is.
export function wrapProviderError(err: unknown, errPrefix: string): never {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    const message = (err as { message?: unknown }).message;
    throw new Error(
      `${errPrefix}_api_error_${typeof status === "number" ? status : "unknown"}: ${
        typeof message === "string" ? message : "unknown"
      }`,
    );
  }
  throw err;
}
