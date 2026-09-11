import { RubricExtractError } from "./extractCore";
import type {
  RubricExtractRequest,
  RubricExtractResult,
  RubricExtractorProvider,
} from "./types";

// Deterministic mock (default provider): a fixed rubric so tests and
// keyless dev get a predictable proposal without AWS. Real extraction
// (bedrockProvider) uses an LLM.
//
// The analytic fixture leaves the middle two levels' points null on the
// first criterion and every level null on the second, so the normaliser's
// ladder paths (linear fill and the all-missing descending ladder) run on
// the default shape. MOCK_RUBRIC_STYLE = "holistic" | "single_point"
// returns those shapes instead.
//
// Failure steering, the same convention as mockPdfExtractor (a marker in
// the text or the file name, rather than module mocking, which leaks
// across files in bun):
//   THROW_TRUNCATED     — the reply hit the token cap
//   THROW_INVALID_JSON  — the reply was not JSON
//   THROW_PROVIDER      — the provider itself failed
//   RETURN_INVALID      — a well-formed reply that no rubric can be made of
// "BLOCKME" anywhere in the input is echoed into a descriptor so the
// guardrail's OUTPUT stage can be steered from a route test.

const ANALYTIC = {
  style: "analytic",
  title: "Mock analytic rubric",
  criteria: [
    {
      name: "Claim",
      levels: [
        { label: "Exceeds", points: 4, descriptor: "States a precise, defensible claim." },
        { label: "Meets", points: null, descriptor: "States a clear claim." },
        { label: "Approaching", points: null, descriptor: "States a vague claim." },
        { label: "Beginning", points: 1, descriptor: "No claim is stated." },
      ],
    },
    {
      name: "Evidence",
      levels: [
        { label: "Exceeds", points: null, descriptor: "Evidence is specific and cited." },
        { label: "Meets", points: null, descriptor: "Evidence supports the claim." },
        { label: "Approaching", points: null, descriptor: "Evidence is thin." },
        { label: "Beginning", points: null, descriptor: "No evidence is offered." },
      ],
    },
  ],
};

const HOLISTIC = {
  style: "holistic",
  title: "Mock holistic rubric",
  criteria: [
    {
      name: "Overall response",
      levels: [
        { label: "4", points: null, descriptor: "Thorough and well supported." },
        { label: "3", points: null, descriptor: "Adequate and mostly supported." },
        { label: "2", points: null, descriptor: "Partial and thinly supported." },
        { label: "1", points: null, descriptor: "Minimal." },
      ],
    },
  ],
};

const SINGLE_POINT = {
  style: "single_point",
  title: "Mock single-point rubric",
  criteria: [
    {
      name: "Claim",
      levels: [{ label: "Target", points: null, descriptor: "States a clear, defensible claim." }],
    },
    {
      name: "Evidence",
      levels: [{ label: "Target", points: null, descriptor: "Supports the claim with evidence." }],
    },
  ],
};

function fixture(): Record<string, unknown> {
  const style = process.env.MOCK_RUBRIC_STYLE ?? "analytic";
  if (style === "holistic") return structuredClone(HOLISTIC);
  if (style === "single_point") return structuredClone(SINGLE_POINT);
  return structuredClone(ANALYTIC);
}

export const mockRubricExtractor: RubricExtractorProvider = {
  id: "mock",

  async extract(req: RubricExtractRequest): Promise<RubricExtractResult> {
    const marker = [req.text ?? "", req.file_name ?? "", req.document?.name ?? ""].join(" ");
    if (marker.includes("THROW_TRUNCATED")) {
      throw new RubricExtractError(
        "truncated",
        "mock: model did not return valid JSON (output hit the token cap)",
      );
    }
    if (marker.includes("THROW_INVALID_JSON")) {
      throw new RubricExtractError("invalid_json", "mock: model did not return valid JSON");
    }
    if (marker.includes("THROW_PROVIDER")) {
      throw new Error("mock_api_error_503: simulated provider outage");
    }
    if (marker.includes("RETURN_INVALID")) {
      // Well-formed JSON the normaliser can make no rubric of — the shape
      // the real model produces when it finds no rubric on the page.
      return { rubric: { style: "analytic", criteria: [] } };
    }
    const rubric = fixture();
    if (marker.includes("BLOCKME")) {
      const first = (rubric.criteria as { levels: { descriptor?: string }[] }[])[0]!;
      first.levels[0]!.descriptor = `BLOCKME ${first.levels[0]!.descriptor ?? ""}`.trim();
    }
    return { rubric };
  },
};
