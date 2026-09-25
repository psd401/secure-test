import type { ScreeningProvider } from "./types";
import { mockScreener } from "./mockProvider";
import { bedrockScreener } from "./bedrockProvider";

// Provider selector, mirroring ../provider.ts. Reads
// SAFEGUARDING_SCREENER_PROVIDER and returns the screener, or `null` when
// screening is off — the default, so the hand-in path runs with zero extra
// work and no writes until a deployment turns it on ("bedrock" in infra,
// "mock" for tests / local demo).

export { mockScreener, bedrockScreener };

export function getScreeningProvider(): ScreeningProvider | null {
  const requested = process.env.SAFEGUARDING_SCREENER_PROVIDER ?? "off";
  if (requested === "off") return null;
  if (requested === "mock") return mockScreener;
  if (requested === "bedrock") return bedrockScreener;
  throw new Error(
    `Unknown SAFEGUARDING_SCREENER_PROVIDER="${requested}"; expected "off", ` +
      `"mock", or "bedrock" (see docs/safeguarding-alerts-design.md).`,
  );
}
