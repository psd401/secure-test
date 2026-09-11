import { RubricSchema, type Rubric } from "@secure-test/schema";

// Rubric upload slice 1 (docs/rubric-upload-design.md §"The extraction").
// Shared between the mock and Bedrock rubric extractors + the route: the
// prompt contract, the JSON parse, and the normalisation that turns the
// model's loose object into a `Rubric` the shared schema accepts — with a
// warning for every repair it had to make.

/** Output cap for one extraction. A rubric is one to three pages. */
export const RUBRIC_EXTRACT_MAX_TOKENS = 6000;

/** RubricLevelSchema's own descriptor bound; anything longer is cut. */
export const MAX_DESCRIPTOR_CHARS = 2000;

/** RubricCriterionSchema's name bound. */
const MAX_CRITERION_NAME_CHARS = 200;

/** RubricLevelSchema's label bound. */
const MAX_LEVEL_LABEL_CHARS = 120;

/** The label a padded level gets (D-3 / `few_levels`). */
export const PADDED_LEVEL_LABEL = "Not evident";

export type RubricExtractErrorCode =
  | "truncated"
  | "invalid_json"
  | "invalid_output";

/**
 * Typed failure from the rubric pipeline so the route answers with a
 * structured, teacher-readable error instead of an empty-body 500 (the
 * lesson `PdfExtractError` was written for, 2026-09-01).
 */
export class RubricExtractError extends Error {
  readonly code: RubricExtractErrorCode;
  /** Zod issues, when the normalised rubric failed `RubricSchema`. */
  readonly issues: string[];
  constructor(code: RubricExtractErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "RubricExtractError";
    this.code = code;
    this.issues = issues;
  }
}

export type RubricWarningCode =
  | "points_assigned"
  | "style_guess"
  | "few_levels"
  | "truncated_text";

export interface RubricWarning {
  code: RubricWarningCode;
  /** Teacher-facing; the dialog renders it above the proposed table. */
  message: string;
}

export interface NormalizedRubric {
  rubric: Rubric;
  warnings: RubricWarning[];
}

// --- the prompt (docs/rubric-upload-design.md, "Prompt contract") ---

export const RUBRIC_EXTRACT_SYSTEM_PROMPT = [
  "You read a teacher's scoring rubric and return it as structured JSON.",
  "Return ONLY ONE JSON object (no markdown fences, no commentary) in this",
  "shape:",
  '{"style":"analytic|holistic|single_point","title":"...","style_inferred":true|false,',
  '"criteria":[{"name":"...","levels":[{"label":"...","points":N|null,"descriptor":"..."}]}]}',
  "Rules:",
  "Keep the criterion and level wording VERBATIM — copy the document's own",
  "words, never paraphrase, summarise or invent a criterion.",
  "A rubric whose rows are criteria and whose columns are performance levels",
  'is "analytic": one entry in criteria per row, one level per column, in',
  "the printed left-to-right order.",
  'A rubric with one set of levels for the work as a whole is "holistic":',
  "exactly one criterion holding every level.",
  'A rubric printed as one column of "criteria" or "target" statements, with',
  "at most a yes/no or below / meets / above split, is \"single_point\": one",
  "criterion per statement, each with the target as its ONE level.",
  "When a level's points are printed, copy them as a number; when they are",
  "not printed anywhere, use null — never guess a number.",
  'Set "style_inferred" to true when the document does not name its own',
  "style and you worked it out from the layout; false when the document says",
  "what it is.",
  '"title" is the rubric\'s printed title; omit it when there is none.',
  "Put a level's full performance description in \"descriptor\" and its short",
  'heading ("Exceeds", "4", "Proficient") in "label"; when a cell has only',
  "one of the two, use it as the label and omit the descriptor.",
  'Inside JSON strings, escape double quotes as \\" and backslashes as \\\\.',
].join(" ");

export function buildRubricExtractUserPrompt(text: string): string {
  return `RUBRIC TEXT:\n\n${text}`;
}

/** The document path: the rubric rides as a Converse document block (D-1). */
export const RUBRIC_DOCUMENT_USER_PROMPT =
  "The rubric is attached as a document. Read it — including its table " +
  "layout, where a row is usually a criterion and a column a performance " +
  "level — and return the JSON object described above.";

// --- parse ---

/**
 * Strip optional markdown fences and parse ONE JSON object. A truncated
 * reply (the provider saw stopReason max_tokens) is reported as such so the
 * teacher is told the rubric was too long rather than "try again".
 */
export function parseRubricExtraction(
  text: string,
  errPrefix: string,
  opts: { truncated?: boolean } = {},
): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new RubricExtractError(
      opts.truncated ? "truncated" : "invalid_json",
      `${errPrefix}: model did not return valid JSON` +
        (opts.truncated ? " (output hit the token cap)" : ""),
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RubricExtractError(
      opts.truncated ? "truncated" : "invalid_json",
      `${errPrefix}: model JSON was not an object`,
    );
  }
  return raw;
}

// --- normalise ---

type RubricStyle = Rubric["style"];

interface DraftLevel {
  label: string;
  points: number | null;
  descriptor?: string;
}

interface DraftCriterion {
  name: string;
  levels: DraftLevel[];
}

const STYLES: readonly RubricStyle[] = ["analytic", "holistic", "single_point"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function readLevel(raw: unknown, onTruncate: () => void): DraftLevel | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const label = typeof obj.label === "string" ? obj.label.trim() : "";
  const descriptorRaw = typeof obj.descriptor === "string" ? obj.descriptor.trim() : "";
  // A cell with only a description and no heading still becomes a level —
  // the heading is the part teachers leave out, not the wording.
  const effectiveLabel = label.length > 0 ? label : descriptorRaw.slice(0, MAX_LEVEL_LABEL_CHARS);
  if (effectiveLabel.length === 0) return null;
  let descriptor = label.length > 0 ? descriptorRaw : "";
  if (descriptor.length > MAX_DESCRIPTOR_CHARS) {
    descriptor = descriptor.slice(0, MAX_DESCRIPTOR_CHARS);
    onTruncate();
  }
  const pointsRaw = typeof obj.points === "string" ? Number(obj.points) : obj.points;
  const points =
    typeof pointsRaw === "number" && Number.isFinite(pointsRaw) && pointsRaw >= 0
      ? pointsRaw
      : null;
  return {
    label: effectiveLabel.slice(0, MAX_LEVEL_LABEL_CHARS),
    points,
    ...(descriptor.length > 0 ? { descriptor } : {}),
  };
}

/** Shape-based style inference, used when the model named none we know. */
function inferStyle(criteria: readonly DraftCriterion[]): RubricStyle {
  if (criteria.every((c) => c.levels.length === 1)) return "single_point";
  if (criteria.length === 1) return "holistic";
  return "analytic";
}

/**
 * D-3: fill in the levels whose points were not printed.
 *
 * - none printed → a descending ladder n-1 … 0 in the printed order.
 * - some printed → a linear fill: between two printed neighbours the value
 *   is interpolated; outside them it continues the printed run's own step
 *   (one printed level alone implies a step of 1 per level, descending).
 *
 * Returns the indexes it touched, so the warning can name them. Values are
 * clamped at 0 (RubricLevelSchema is non-negative) and rounded to 2 dp.
 */
export function assignPointLadder(levels: DraftLevel[]): number[] {
  const missing = levels.map((l, i) => (l.points === null ? i : -1)).filter((i) => i >= 0);
  if (missing.length === 0) return [];
  const known = levels
    .map((l, i) => (l.points === null ? null : { i, v: l.points }))
    .filter((k): k is { i: number; v: number } => k !== null);
  if (known.length === 0) {
    levels.forEach((l, i) => {
      l.points = levels.length - 1 - i;
    });
    return missing;
  }
  const first = known[0]!;
  const last = known[known.length - 1]!;
  const step = known.length >= 2 ? (last.v - first.v) / (last.i - first.i) : -1;
  for (const i of missing) {
    const prev = [...known].reverse().find((k) => k.i < i);
    const next = known.find((k) => k.i > i);
    let value: number;
    if (prev && next) {
      value = prev.v + ((next.v - prev.v) * (i - prev.i)) / (next.i - prev.i);
    } else if (prev) {
      value = prev.v + (i - prev.i) * step;
    } else {
      value = next!.v + (i - next!.i) * step;
    }
    levels[i]!.points = Math.max(0, round2(value));
  }
  return missing;
}

/**
 * Turn the model's raw object into a `Rubric`, warning about every repair.
 * Throws `RubricExtractError("invalid_output")` — carrying the Zod issues —
 * when the result still does not satisfy the shared schema, which is the
 * ONE validation authority here (the same posture as `CreateItemBody` in
 * the PDF importer).
 */
export function normalizeRubric(raw: unknown): NormalizedRubric {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RubricExtractError("invalid_output", "rubric was not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const warnings: RubricWarning[] = [];
  let truncatedCount = 0;

  const rawCriteria = Array.isArray(obj.criteria) ? obj.criteria : [];
  const drafts: DraftCriterion[] = [];
  for (const entry of rawCriteria) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    const levels = (Array.isArray(c.levels) ? c.levels : [])
      .map((l) => readLevel(l, () => (truncatedCount += 1)))
      .filter((l): l is DraftLevel => l !== null);
    // Drop empty criteria — a stray header row comes back as one.
    if (name.length === 0 || levels.length === 0) continue;
    drafts.push({ name: name.slice(0, MAX_CRITERION_NAME_CHARS), levels });
  }
  if (drafts.length === 0) {
    throw new RubricExtractError(
      "invalid_output",
      "the model returned no usable criteria",
      ["criteria: at least one criterion with at least one level is required"],
    );
  }

  const declared = typeof obj.style === "string" ? (obj.style as RubricStyle) : null;
  let style: RubricStyle;
  let guessed = obj.style_inferred === true;
  if (declared !== null && STYLES.includes(declared)) {
    style = declared;
  } else {
    style = inferStyle(drafts);
    guessed = true;
  }
  // A declared style the returned shape contradicts is not usable: holistic
  // means exactly one criterion, single_point exactly one level each. Fall
  // back to the shape's own reading rather than 422-ing on the model's label.
  if (
    (style === "holistic" && drafts.length !== 1) ||
    (style === "single_point" && drafts.some((c) => c.levels.length !== 1))
  ) {
    style = "analytic";
    guessed = true;
  }

  if (guessed) {
    warnings.push({
      code: "style_guess",
      message:
        `The rubric's style was not stated in the document — read as ` +
        `"${style}". Check it before saving.`,
    });
  }

  // few_levels: an analytic / holistic criterion under two levels is padded
  // with an empty 0-point level so the shared schema's cardinality holds.
  const padded: string[] = [];
  if (style !== "single_point") {
    for (const c of drafts) {
      while (c.levels.length < 2) {
        c.levels.push({ label: PADDED_LEVEL_LABEL, points: 0 });
        padded.push(c.name);
      }
    }
  }
  if (padded.length > 0) {
    warnings.push({
      code: "few_levels",
      message:
        `Only one level was found for ${padded.map((n) => `"${n}"`).join(", ")} — ` +
        `an empty "${PADDED_LEVEL_LABEL}" level worth 0 was added.`,
    });
  }

  // D-3 point ladders.
  const assigned: string[] = [];
  for (const c of drafts) {
    if (style === "single_point") {
      for (const l of c.levels) {
        if (l.points === null) {
          l.points = 1;
          assigned.push(`"${c.name}" → "${l.label}" = 1`);
        }
      }
      continue;
    }
    for (const i of assignPointLadder(c.levels)) {
      assigned.push(`"${c.name}" → "${c.levels[i]!.label}" = ${c.levels[i]!.points}`);
    }
  }
  if (assigned.length > 0) {
    warnings.push({
      code: "points_assigned",
      message:
        "Points were not printed for every level — assigned " +
        `${assigned.join(", ")}. Check them before saving.`,
    });
  }

  if (truncatedCount > 0) {
    warnings.push({
      code: "truncated_text",
      message:
        `${truncatedCount} level description${truncatedCount === 1 ? " was" : "s were"} ` +
        `longer than ${MAX_DESCRIPTOR_CHARS} characters and ${truncatedCount === 1 ? "was" : "were"} cut.`,
    });
  }

  let levelSeq = 0;
  const candidate = {
    style,
    criteria: drafts.map((c, ci) => ({
      id: `c${ci + 1}`,
      name: c.name,
      levels: c.levels.map((l) => ({
        id: `l${(levelSeq += 1)}`,
        label: l.label,
        points: l.points ?? 0,
        ...(l.descriptor ? { descriptor: l.descriptor } : {}),
      })),
    })),
  };

  const parsed = RubricSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RubricExtractError(
      "invalid_output",
      "the extracted rubric did not match the rubric schema",
      parsed.error.issues.map((iss) => {
        const path = iss.path.join(".");
        return path ? `${path}: ${iss.message}` : iss.message;
      }),
    );
  }
  return { rubric: parsed.data, warnings };
}

/** Model output the guardrail screens: every criterion name + descriptor. */
export function rubricOutputText(rubric: Rubric): string {
  return rubric.criteria
    .flatMap((c) => [c.name, ...c.levels.map((l) => l.descriptor ?? "")])
    .filter((t) => t.length > 0)
    .join("\n");
}
