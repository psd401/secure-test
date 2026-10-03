// BG slice 4 (docs/batch-item-generation-design.md): the pure half of the
// "Generate questions" dialog — form validation, the request the route
// takes, error copy, and the "Check the key" state. Client-safe: nothing here
// imports lib/ai/types.ts (it pulls server-only provider types); the limits
// are mirrored from there and kept honest by test/batch-form.test.ts.

export const BATCH_MAX_COUNT = 10;
export const BATCH_MAX_OBJECTIVE = 500;
export const BATCH_MAX_NOTES = 2000;
/** The rubric upload's pasted-text cap (MAX_RUBRIC_TEXT_CHARS). */
export const BATCH_MAX_RESOURCE_CHARS = 200_000;
export const BATCH_MAX_FILE_BYTES = 5 * 1024 * 1024;

export const BATCH_TYPES = [
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
  "essay",
] as const;
export type BatchType = (typeof BATCH_TYPES)[number];

export const BATCH_TYPE_LABEL: Record<BatchType, string> = {
  multiple_choice_single: "Multiple choice (one answer)",
  multiple_choice_multi: "Multiple choice (select all)",
  short_text: "Short text",
  essay: "Essay",
};

export const BATCH_DIFFICULTIES = ["mixed", "easier", "on_level", "harder"] as const;
export type BatchDifficulty = (typeof BATCH_DIFFICULTIES)[number];
export const BATCH_DIFFICULTY_LABEL: Record<BatchDifficulty, string> = {
  mixed: "Mixed",
  easier: "Easier",
  on_level: "On level",
  harder: "Harder",
};

/** The file types the route accepts (documentUpload.ts ALLOWED_UPLOADS). */
export const BATCH_FILE_ACCEPT = ".pdf,.docx,.md,.txt";

export interface BatchFormValues {
  /** Kept as typed so a half-edited field is not coerced; see `parseCount`. */
  count: string;
  typeMode: "mix" | "counts";
  typeCounts: Record<BatchType, string>;
  standards: string[];
  objective: string;
  /** Pasted source material; a file AND pasted text together is an error. */
  resourceText: string;
  file: File | null;
  difficulty: BatchDifficulty;
  notes: string;
}

export function emptyBatchForm(): BatchFormValues {
  return {
    count: "5",
    typeMode: "mix",
    typeCounts: {
      multiple_choice_single: "",
      multiple_choice_multi: "",
      short_text: "",
      essay: "",
    },
    standards: [],
    objective: "",
    resourceText: "",
    file: null,
    difficulty: "mixed",
    notes: "",
  };
}

/** 1..10 as a whole number, else null. */
export function parseCount(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= BATCH_MAX_COUNT ? n : null;
}

function parseTypeCount(raw: string): number {
  const t = raw.trim();
  if (t === "") return 0;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

export interface BatchFormErrors {
  count?: string;
  types?: string;
  focus?: string;
  resource?: string;
  objective?: string;
  notes?: string;
  file?: string;
}

/** The sum shown beside the per-type inputs (unparseable entries count 0). */
export function typeCountSum(v: Pick<BatchFormValues, "typeCounts">): number {
  return BATCH_TYPES.reduce((a, t) => {
    const n = parseTypeCount(v.typeCounts[t]);
    return a + (Number.isNaN(n) ? 0 : n);
  }, 0);
}

/** The route's own rule (hasBatchFocus): something to write the questions about. */
export function hasFocus(v: BatchFormValues): boolean {
  return (
    v.standards.length > 0 ||
    v.objective.trim() !== "" ||
    v.resourceText.trim() !== "" ||
    v.file !== null ||
    v.notes.trim() !== ""
  );
}

export function validateBatchForm(v: BatchFormValues): BatchFormErrors {
  const errors: BatchFormErrors = {};
  const count = parseCount(v.count);
  if (count === null) errors.count = `Enter a number from 1 to ${BATCH_MAX_COUNT}.`;

  if (v.typeMode === "counts") {
    const parsed = BATCH_TYPES.map((t) => parseTypeCount(v.typeCounts[t]));
    if (parsed.some((n) => Number.isNaN(n))) {
      errors.types = "Type counts must be whole numbers.";
    } else if (count !== null) {
      const sum = parsed.reduce((a, n) => a + n, 0);
      if (sum !== count) {
        errors.types = `Type counts add up to ${sum}, but you asked for ${count}. They must match.`;
      }
    }
  }

  if (v.objective.trim().length > BATCH_MAX_OBJECTIVE) {
    errors.objective = `The objective is limited to ${BATCH_MAX_OBJECTIVE} characters.`;
  }
  if (v.notes.trim().length > BATCH_MAX_NOTES) {
    errors.notes = `Notes are limited to ${BATCH_MAX_NOTES} characters.`;
  }
  if (v.file && v.resourceText.trim()) {
    errors.resource = "Use a file or pasted text for the source material, not both.";
  } else if (v.resourceText.trim().length > BATCH_MAX_RESOURCE_CHARS) {
    errors.resource = "The pasted source material is too long. Use a file or shorten it.";
  }
  if (v.file && v.file.size > BATCH_MAX_FILE_BYTES) {
    errors.file = "The file is over 5 MB.";
  }

  if (!hasFocus(v)) {
    errors.focus = "Give at least one of standards, an objective, source material or notes.";
  }
  return errors;
}

export function canGenerate(v: BatchFormValues): boolean {
  return Object.keys(validateBatchForm(v)).length === 0;
}

/** The route's JSON body. Call only when `canGenerate`. */
export function buildBatchRequest(assessmentId: string, v: BatchFormValues): Record<string, unknown> {
  const count = parseCount(v.count) ?? 0;
  let types: "mix" | Record<string, number> = "mix";
  if (v.typeMode === "counts") {
    const counts: Record<string, number> = {};
    for (const t of BATCH_TYPES) {
      const n = parseTypeCount(v.typeCounts[t]);
      if (n > 0) counts[t] = n;
    }
    types = counts;
  }
  const objective = v.objective.trim();
  const notes = v.notes.trim();
  const resourceText = v.resourceText.trim();
  return {
    assessment_id: assessmentId,
    count,
    types,
    ...(v.standards.length > 0 || objective
      ? {
          target: {
            ...(v.standards.length > 0 ? { standards: v.standards } : {}),
            ...(objective ? { objective } : {}),
          },
        }
      : {}),
    difficulty: v.difficulty,
    ...(notes ? { notes } : {}),
    // With a file the text path is empty by validation, so no resource key.
    ...(!v.file && resourceText ? { resource: { text: resourceText } } : {}),
  };
}

/** The fetch init for the route: multipart when a file was chosen, else JSON. */
export function buildBatchFetchInit(assessmentId: string, v: BatchFormValues): RequestInit {
  const body = buildBatchRequest(assessmentId, v);
  if (v.file) {
    const form = new FormData();
    form.append("request", JSON.stringify(body));
    form.append("file", v.file);
    return { method: "POST", body: form };
  }
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface GenerateErrorBody {
  error?: string;
  detail?: string;
  hint?: string;
  note?: string;
}

/** What the dialog shows for a non-2xx answer. */
export function describeGenerateError(status: number, body: GenerateErrorBody | null): string {
  if (status === 403 && body?.error === "llm_authoring_disabled") {
    return "AI authoring is turned off for this assessment. Turn it on in Settings.";
  }
  if (status === 413) return "The file is over 5 MB.";
  if (status === 415) {
    return body?.hint ?? "Upload a PDF, a Word document (.docx), Markdown or a plain-text file.";
  }
  if (status === 422 && body?.error === "guardrail_blocked") {
    return body.note ?? "The request was blocked by content safeguards. Edit it and try again.";
  }
  if (status === 502) {
    return "The AI couldn't produce questions — try again or change the request.";
  }
  if (status === 400) {
    return body?.detail
      ? `The request wasn't accepted: ${body.detail}`
      : "The request wasn't accepted. Check the form and try again.";
  }
  return "Something went wrong generating questions. Try again.";
}

/**
 * What the dialog shows when Add (POST to the items route) is refused. The
 * 2026-10-02 hand-run (row 367) showed the raw `assessment_published_editing_locked`
 * after a Publish from another tab stopped an Add all.
 */
export function describeAddError(status: number, body: GenerateErrorBody | null): string {
  if (status === 409 && body?.error === "assessment_published_editing_locked") {
    return "the assessment was published, so no more questions can be added. Unpublish it to add the rest.";
  }
  if (status === 404) return "this assessment is no longer available to you.";
  if (status === 400) {
    return body?.detail ? `the question wasn't accepted (${body.detail}).` : "the question wasn't accepted.";
  }
  return "something went wrong adding the question. Try again.";
}

// ── Proposals ──────────────────────────────────────────────────────────────

/** A proposal as the route returns it: a CreateItemBody-shaped item. */
export interface BatchProposal {
  type: string;
  stem: string;
  choices?: { id: string; text: string }[];
  correct_choice_ids?: string[];
  correct_answer?: string | null;
  standards?: string[];
  [key: string]: unknown;
}

/** D-6: only items that carry an AI key get the badge (an essay has none). */
export function hasProposedKey(p: BatchProposal): boolean {
  if (p.type === "short_text") return (p.correct_answer ?? "") !== "";
  if (p.type === "multiple_choice_single" || p.type === "multiple_choice_multi") {
    return (p.correct_choice_ids?.length ?? 0) > 0;
  }
  return false;
}

/** "Check the key" shows until the teacher has opened this card's key. */
export function needsKeyCheck(
  p: BatchProposal,
  reviewed: ReadonlySet<string>,
  cardId: string,
): boolean {
  return hasProposedKey(p) && !reviewed.has(cardId);
}

/** "5 questions ready" plus "1 couldn't be used" when the route dropped any. */
export function proposalHeader(ready: number, dropped: number): string {
  const head = `${ready} question${ready === 1 ? "" : "s"} ready`;
  return dropped > 0 ? `${head} · ${dropped} couldn't be used` : head;
}

/** The key as text: a short answer, or the text of each correct choice. */
export function keyText(p: BatchProposal): string[] {
  if (p.type === "short_text") return p.correct_answer ? [p.correct_answer] : [];
  const byId = new Map((p.choices ?? []).map((c) => [c.id, c.text]));
  return (p.correct_choice_ids ?? []).map((id) => byId.get(id) ?? id);
}

export type AddAllResult =
  | { ok: true; added: string[] }
  | { ok: false; added: string[]; failedId: string; message: string };

/**
 * Sequential Add all: stops at the first failure and reports it, with the ids
 * added before it (the caller drops those cards from the list).
 */
export async function addAllSequentially(
  ids: readonly string[],
  addOne: (id: string) => Promise<void>,
): Promise<AddAllResult> {
  const added: string[] = [];
  for (const id of ids) {
    try {
      await addOne(id);
      added.push(id);
    } catch (e) {
      return {
        ok: false,
        added,
        failedId: id,
        message: e instanceof Error ? e.message : "Could not add the question.",
      };
    }
  }
  return { ok: true, added };
}
