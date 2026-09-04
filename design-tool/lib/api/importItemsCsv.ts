import { parseCsvRecords } from "./csvParse";
import { CreateItemBody } from "./items";

// Slice 41: template-driven CSV item import. One row per question; parse +
// validate each row through CreateItemBody (the SAME discriminated-union +
// superRefine the manual editor and JSON import use), so scoring-method
// rules, choice minimums, and rubric requirements are enforced identically.
// Errors are reported PER ROW — a bad row never blocks the good ones.
//
// Template columns (header row required, order-independent, extra columns
// ignored):
//   type            multiple_choice_single | multiple_choice_multi |
//                   short_text | essay
//   stem            required, the question text
//   choices         MC only: "id:text" pairs joined by "|", e.g.
//                   "a:Paris|b:London|c:Rome". First ":" splits id/text so
//                   the text may contain colons. Blank for short_text/essay.
//   correct         MC single: one choice id. MC multi: "|"-joined ids.
//                   short_text: the answer string. Essay: blank.
//   scoring_method  optional: auto | ai | human | hybrid
//   max_word_count  essay only, optional positive integer
//   placeholder     essay only, optional
//   rubric_json     essay only, optional: a JSON Rubric object (validated
//                   against RubricSchema via CreateItemBody)

export const ITEM_CSV_COLUMNS = [
  "type",
  "stem",
  "choices",
  "correct",
  "scoring_method",
  "max_word_count",
  "placeholder",
  "rubric_json",
] as const;

export type ItemCsvRow = {
  line: number; // 1-based source line (header is line 1)
  raw: Record<string, string>;
  errors: string[];
  // Present only when the row validated. Shape matches CreateItemBody.
  item?: ReturnType<typeof CreateItemBody.parse>;
};

export type ItemsCsvParse = {
  headerError?: string;
  rows: ItemCsvRow[];
  validCount: number;
  invalidCount: number;
};

function parseChoices(cell: string): { id: string; text: string }[] {
  return cell
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx < 0) return { id: pair, text: "" };
      return { id: pair.slice(0, idx).trim(), text: pair.slice(idx + 1).trim() };
    });
}

// Build the candidate object for one row, shaped for CreateItemBody. Any
// structural problem (bad rubric JSON) is returned as an error string so
// the row still reports rather than throwing.
function buildCandidate(
  get: (col: string) => string,
): { candidate?: Record<string, unknown>; error?: string } {
  const type = get("type");
  const stem = get("stem");
  const base: Record<string, unknown> = { type, stem };

  const scoring = get("scoring_method");
  if (scoring) base.scoring_method = scoring;

  if (type === "multiple_choice_single" || type === "multiple_choice_multi") {
    base.choices = parseChoices(get("choices"));
    const correct = get("correct");
    base.correct_choice_ids =
      type === "multiple_choice_multi"
        ? correct.split("|").map((s) => s.trim()).filter((s) => s.length > 0)
        : correct
          ? [correct.trim()]
          : [];
  } else if (type === "short_text") {
    base.correct_answer = get("correct");
  } else if (type === "essay") {
    const mwc = get("max_word_count");
    if (mwc) {
      const n = Number(mwc);
      if (Number.isInteger(n)) base.max_word_count = n;
      else return { error: `max_word_count "${mwc}" is not an integer` };
    }
    const placeholder = get("placeholder");
    if (placeholder) base.placeholder = placeholder;
    const rubricRaw = get("rubric_json");
    if (rubricRaw) {
      try {
        base.rubric = JSON.parse(rubricRaw);
      } catch {
        return { error: "rubric_json is not valid JSON" };
      }
    }
  } else if (
    type === "match" ||
    type === "order" ||
    type === "hotspot" ||
    type === "drawing_upload" ||
    type === "table"
  ) {
    // Slices 47-50 + E3: valid item types, but structural — the row-per-question
    // template can't carry pairs/sequences/regions/canvas/grid metadata. Reject
    // explicitly instead of surfacing a confusing validation error.
    return { error: `type "${type}" is not supported by CSV import — author it in the editor` };
  }
  // Unknown type: leave as-is; CreateItemBody rejects with a clear message.
  return { candidate: base };
}

export function parseItemsCsv(text: string): ItemsCsvParse {
  // Review fix (2026-08-14): records carry their physical source line —
  // quoted cells may contain newlines, so a record index is not a line.
  const records = parseCsvRecords(text);
  const grid = records.map((rec) => rec.cells);
  if (grid.length === 0) {
    return { headerError: "empty file", rows: [], validCount: 0, invalidCount: 0 };
  }
  const header = grid[0]!.map((h) => h.trim().toLowerCase());
  if (!header.includes("type") || !header.includes("stem")) {
    return {
      headerError: `header must include at least "type" and "stem"; got: ${header.join(", ")}`,
      rows: [],
      validCount: 0,
      invalidCount: 0,
    };
  }
  const colIndex = new Map(header.map((h, i) => [h, i]));

  const rows: ItemCsvRow[] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    // Skip fully blank lines (trailing separators, editor artifacts).
    if (cells.every((c) => c.trim() === "")) continue;

    const raw: Record<string, string> = {};
    for (const col of ITEM_CSV_COLUMNS) {
      const idx = colIndex.get(col);
      raw[col] = idx != null ? (cells[idx] ?? "").trim() : "";
    }
    const get = (col: string) => raw[col] ?? "";

    const line = records[r]!.line; // physical 1-based source line
    const { candidate, error } = buildCandidate(get);
    if (error) {
      rows.push({ line, raw, errors: [error] });
      invalidCount++;
      continue;
    }
    const parsed = CreateItemBody.safeParse(candidate);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((iss) => {
        const path = iss.path.join(".");
        return path ? `${path}: ${iss.message}` : iss.message;
      });
      rows.push({ line, raw, errors });
      invalidCount++;
      continue;
    }
    rows.push({ line, raw, errors: [], item: parsed.data });
    validCount++;
  }

  return { rows, validCount, invalidCount };
}
