import { PdfExtractError } from "./extractCore";
import type {
  PdfExtractRequest,
  PdfExtractResult,
  PdfExtractorProvider,
} from "./types";

// Deterministic mock (default provider): parses a tiny token-delimited
// convention so tests and keyless dev get predictable candidates without
// AWS. Real extraction (bedrockProvider) uses an LLM. Segments are split on
// the leading token (NOT newlines — PDF text extraction joins lines with
// spaces, so the mock must tolerate a single-line blob):
//   MC: <stem> | a:<text> | b:<text> | *<correct letter>
//   ST: <stem> | <correct answer>
//   ES: <stem>
//   MA: <stem> | <left>=<right> | <left>=<right>      (E1 match; no pair ids —
//                                                      the normalizer assigns)
//   DR: <stem>                                        (E2/E4 drawing_upload)
//   TB: <stem> | cols=<a>,<b> | rows=<x>,<y> | corner=<z>  (E3 table; rows= and
//                                                      corner= may be omitted)
//   SET: #<a>-<b> | figure=<n>[,<n>] | <stimulus text>  (E5 slice 3: a proposed
//        item set over the segments whose printed numbers fall in a..b;
//        "figure=" may be omitted for a passage-only set)
// A body may start with "#<n>" to claim a printed question number
// (E8 `source_number`), e.g. "MC: #3 What is ...", or "#<a>-<b>" to claim a
// range (`source_numbers`, a match set built from rows 1-5).
// Text that doesn't start a segment is ignored. This is a stand-in, not a
// parser teachers rely on — the Bedrock provider does the real work.

const SEGMENT_RE = /(MC|ST|ES|MA|DR|TB|SET):\s*(.*?)(?=(?:MC|ST|ES|MA|DR|TB|SET):|$)/gs;

function parseSegment(kind: string, bodyRaw: string): unknown | null {
  const numbered = /^#(\d+)(?:-(\d+))?\s*/.exec(bodyRaw.trim());
  const body = numbered ? bodyRaw.trim().slice(numbered[0].length) : bodyRaw.trim();
  const withNumber = (cand: Record<string, unknown>) => {
    if (!numbered) return cand;
    const from = Number(numbered[1]);
    if (numbered[2] === undefined) return { ...cand, source_number: from };
    const to = Number(numbered[2]);
    const source_numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { ...cand, source_numbers };
  };
  if (kind === "MA") {
    const parts = body.split("|").map((p) => p.trim());
    const stem = parts.shift() ?? "";
    const pairs = parts
      .map((p) => {
        const idx = p.indexOf("=");
        return idx > 0 ? { left: p.slice(0, idx).trim(), right: p.slice(idx + 1).trim() } : null;
      })
      .filter((p): p is { left: string; right: string } => p !== null);
    return withNumber({ type: "match", stem, pairs });
  }
  if (kind === "DR") {
    return withNumber({ type: "drawing_upload", stem: body });
  }
  if (kind === "TB") {
    // Labels as bare strings, the way the prompt asks the model for them;
    // the normalizer assigns ids.
    const parts = body.split("|").map((p) => p.trim());
    const stem = parts.shift() ?? "";
    const list = (key: string): string[] | undefined => {
      const part = parts.find((p) => p.startsWith(`${key}=`));
      return part === undefined ? undefined : part.slice(key.length + 1).split(",").map((x) => x.trim());
    };
    const cornerPart = parts.find((p) => p.startsWith("corner="));
    return withNumber({
      type: "table",
      stem,
      columns: list("cols") ?? [],
      rows: list("rows") ?? [""],
      ...(cornerPart ? { corner: cornerPart.slice("corner=".length).trim() } : {}),
    });
  }
  if (kind === "MC") {
    const parts = body.split("|").map((p) => p.trim());
    const stem = parts.shift() ?? "";
    let correct = "";
    const choices: { id: string; text: string }[] = [];
    for (const p of parts) {
      if (p.startsWith("*")) {
        correct = p.slice(1).trim();
        continue;
      }
      const idx = p.indexOf(":");
      if (idx > 0) {
        choices.push({ id: p.slice(0, idx).trim(), text: p.slice(idx + 1).trim() });
      }
    }
    return withNumber({
      type: "multiple_choice_single",
      stem,
      choices,
      correct_choice_ids: correct ? [correct] : [],
    });
  }
  if (kind === "ST") {
    const [stem, answer] = body.split("|").map((p) => p.trim());
    return withNumber({ type: "short_text", stem: stem ?? "", correct_answer: answer ?? "" });
  }
  return withNumber({ type: "essay", stem: body });
}

export const mockPdfExtractor: PdfExtractorProvider = {
  id: "mock",

  async extract(req: PdfExtractRequest): Promise<PdfExtractResult> {
    // Failure steering for route tests (same idea as "BLOCKME.pdf" for the
    // guardrail): a marker in the text makes the mock fail the way the real
    // provider does, so the route's error mapping is covered without module
    // mocking (which leaks across files in bun).
    if (req.text.includes("THROW_TRUNCATED")) {
      throw new PdfExtractError(
        "truncated",
        "mock: model did not return valid JSON (output hit the token cap)",
      );
    }
    if (req.text.includes("THROW_INVALID_JSON")) {
      throw new PdfExtractError("invalid_json", "mock: model did not return valid JSON");
    }
    if (req.text.includes("THROW_PROVIDER")) {
      throw new Error("mock_api_error_503: simulated provider outage");
    }
    // Scanned path (slice 44): a mock can't OCR, so it returns a fixed,
    // deterministic fixture. The first stem echoes the file name so route
    // tests can steer the output-stage guardrail (e.g. "BLOCKME.pdf").
    // The second stem and the sets model what the real model did on the
    // 2026-09-02 Graphing Skills scan (E14 + row 31 + E13): a `[FIGURE 1]`
    // marker for a figure that was never extracted, a figure-only set with
    // nothing usable in it, and a set that says its question depends on a
    // figure it could not attach. The route strips the first, drops the
    // second and keeps the third with its flag; this fixture keeps all
    // three shapes under test.
    if (req.scanned_pdf) {
      const name = req.file_name ?? "document";
      return {
        candidates: [
          {
            type: "multiple_choice_single",
            stem: `OCR mock from ${name}: What is 2 + 2?`,
            choices: [
              { id: "a", text: "3" },
              { id: "b", text: "4" },
            ],
            correct_choice_ids: ["b"],
          },
          {
            type: "short_text",
            stem: "OCR mock: What is the capital of Washington State? [FIGURE 1]",
            correct_answer: "Olympia",
          },
        ],
        proposed_sets: [
          { stimulus: "", figures: [1], item_indexes: [1] },
          { stimulus: "", figures: [], item_indexes: [0], needs_figure: true },
        ],
      };
    }
    const candidates: unknown[] = [];
    const setSpecs: { from: number; to: number; figures: number[]; stimulus: string }[] = [];
    for (const m of req.text.matchAll(SEGMENT_RE)) {
      if (m[1] === "SET") {
        const spec = /^#(\d+)(?:-(\d+))?\s*(?:\|\s*figure=([\d,\s]+))?\s*(?:\|\s*(.*))?$/s.exec(m[2]!.trim());
        if (spec) {
          setSpecs.push({
            from: Number(spec[1]),
            to: Number(spec[2] ?? spec[1]),
            figures: (spec[3] ?? "").split(",").map((x) => Number(x.trim())).filter((n) => n > 0),
            stimulus: (spec[4] ?? "").trim(),
          });
        }
        continue;
      }
      const parsed = parseSegment(m[1]!, m[2]!);
      if (parsed) candidates.push(parsed);
    }
    // Resolve each SET to the raw indexes of the candidates whose printed
    // number falls in its range — the same 0-based item_indexes the real
    // model is asked for.
    const proposed_sets = setSpecs.map((spec) => ({
      stimulus: spec.stimulus,
      figures: spec.figures,
      item_indexes: candidates
        .map((c, i) => {
          const n = (c as { source_number?: number }).source_number;
          return typeof n === "number" && n >= spec.from && n <= spec.to ? i : -1;
        })
        .filter((i) => i >= 0),
    }));
    return { candidates, ...(proposed_sets.length > 0 ? { proposed_sets } : {}) };
  },
};
