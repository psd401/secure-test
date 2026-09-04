import Anthropic from "@anthropic-ai/sdk";

// Shared direct-Anthropic-API client, mirroring how lib/ai/bedrockConverse.ts
// centralizes `bedrockClient()` for the Bedrock family.
//
// This existed as two separate cached clients — one in lib/ai/anthropicProvider.ts
// (item generation) and one in lib/ai/mathTranslator/anthropicProvider.ts (math
// translation) — whose bodies differed only in which env var their error
// message named. Two clients means two SDK instances and two connection pools
// against the same API key, and any client-level change (a timeout, a retry
// policy, a default header) had to be made twice or silently applied to only
// one AI surface.

let cachedClient: Anthropic | null = null;

/**
 * @param settingHint The provider setting the caller was selected by, quoted
 *   back in the missing-key error so the operator knows which env var turned
 *   this path on — e.g. "AI_PROVIDER=anthropic".
 *
 * Unlike the Bedrock client, this pre-checks ANTHROPIC_API_KEY: the direct API
 * has exactly one credential source, so a missing key is a configuration error
 * we can name precisely instead of a 401 surfaced from the first call.
 */
export function anthropicClient(settingHint: string): Anthropic {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Set it in design-tool/.env.local " +
        `or the runtime env to use ${settingHint}.`,
    );
  }
  cachedClient = new Anthropic();
  return cachedClient;
}
