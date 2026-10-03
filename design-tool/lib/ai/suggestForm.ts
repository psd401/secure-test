// BG slice 5 (docs/batch-item-generation-design.md D-2): the pure half of
// "Suggest standards" — the form's validation, the request the route takes,
// error copy, the summary line, and the page-state helpers for the Accept /
// Dismiss chips. Client-safe: nothing here imports lib/ai/types.ts (it pulls
// server-side provider types); the limits are mirrored from there and kept
// honest by test/suggest-form.test.ts.

export const SUGGEST_MAX_UNIT_LIST = 20000;
export const SUGGEST_ITEM_CAP = 40;

export const SUGGEST_SUBJECTS = ["math", "ela", "science"] as const;
export type SuggestSubject = (typeof SUGGEST_SUBJECTS)[number];
export const SUGGEST_SUBJECT_LABEL: Record<SuggestSubject, string> = {
  math: "Math",
  ela: "ELA",
  science: "Science",
};

export type SuggestScheme = "wa2026" | "ccss2010";

export interface SuggestFormValues {
  subject: SuggestSubject | "";
  gradeBand: string;
  course: string;
  scheme: SuggestScheme;
  /** Pasted unit standards (1.2: paste only); blank = none. */
  unitList: string;
}

export function emptySuggestForm(prefill: Partial<SuggestFormValues> = {}): SuggestFormValues {
  return { subject: "", gradeBand: "", course: "", scheme: "wa2026", unitList: "", ...prefill };
}

/** The picker's grade-band wording, shared so the two selects read the same. */
export function gradeBandLabel(band: string): string {
  return band === "K" ? "Kindergarten" : /^\d+$/.test(band) ? `Grade ${band}` : band;
}

/** Only HS math has courses. */
export function needsCourse(v: Pick<SuggestFormValues, "subject" | "gradeBand">): boolean {
  return v.subject === "math" && v.gradeBand === "HS";
}

export interface SuggestFormErrors {
  subject?: string;
  gradeBand?: string;
  unitList?: string;
}

export function validateSuggestForm(v: SuggestFormValues): SuggestFormErrors {
  const errors: SuggestFormErrors = {};
  if (!v.subject) errors.subject = "Choose a subject.";
  if (v.subject && !v.gradeBand) errors.gradeBand = "Choose a grade.";
  if (v.unitList.trim().length > SUGGEST_MAX_UNIT_LIST) {
    errors.unitList = "The pasted list is too long. Paste only this unit's standards.";
  }
  return errors;
}

export function canSuggest(v: SuggestFormValues): boolean {
  return Object.keys(validateSuggestForm(v)).length === 0;
}

/** The route's JSON body. Call only when `canSuggest`. */
export function buildSuggestRequest(assessmentId: string, v: SuggestFormValues): Record<string, unknown> {
  const unitList = v.unitList.trim();
  return {
    assessment_id: assessmentId,
    subject: v.subject,
    grade_band: v.gradeBand,
    ...(needsCourse(v) && v.course ? { course: v.course } : {}),
    // Science has one scheme (NGSS); the server ignores it there.
    ...(v.subject !== "science" ? { scheme: v.scheme } : {}),
    ...(unitList ? { unit_list: unitList } : {}),
  };
}

export function buildSuggestFetchInit(assessmentId: string, v: SuggestFormValues): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSuggestRequest(assessmentId, v)),
  };
}

interface SuggestErrorBody {
  error?: string;
  detail?: string;
  note?: string;
}

/** What the dialog shows for a non-2xx answer. */
export function describeSuggestError(status: number, body: SuggestErrorBody | null): string {
  if (status === 403 && body?.error === "llm_authoring_disabled") {
    return "AI authoring is turned off for this assessment. Turn it on in Settings.";
  }
  if (status === 404) return "This assessment is no longer available to you.";
  if (status === 422 && body?.error === "guardrail_blocked") {
    return body.note ?? "The request was blocked by content safeguards. Edit it and try again.";
  }
  if (status === 502) return "The AI couldn't suggest standards — try again.";
  if (status === 400) {
    return body?.detail
      ? `The request wasn't accepted: ${body.detail}`
      : "The request wasn't accepted. Check the form and try again.";
  }
  return "Something went wrong suggesting standards. Try again.";
}

// ── The answer, as page state ──────────────────────────────────────────────

export interface SuggestedTag {
  tag: string;
  reason: string;
}

export interface SuggestResponse {
  suggestions: { item_id: string; tags: SuggestedTag[] }[];
  considered: number;
  left_out: number;
}

/** item id → the chips still showing on its card. Lost on reload (1.1). */
export type SuggestionMap = Record<string, SuggestedTag[]>;

/**
 * A new answer replaces what was showing: it was computed against the items
 * that were untagged at that moment, so older chips may already be stale.
 */
export function suggestionMapFrom(res: Pick<SuggestResponse, "suggestions">): SuggestionMap {
  const out: SuggestionMap = {};
  for (const s of res.suggestions) if (s.tags.length > 0) out[s.item_id] = s.tags;
  return out;
}

/** Accept and Dismiss both take the chip off the card. */
export function removeSuggestion(map: SuggestionMap, itemId: string, tag: string): SuggestionMap {
  const list = map[itemId];
  if (!list) return map;
  const next = { ...map };
  const rest = list.filter((t) => t.tag !== tag);
  if (rest.length > 0) next[itemId] = rest;
  else delete next[itemId];
  return next;
}

export function suggestionCount(map: SuggestionMap): number {
  return Object.values(map).reduce((n, tags) => n + tags.length, 0);
}

function questions(n: number): string {
  return `${n} question${n === 1 ? "" : "s"}`;
}

/** The line shown on the Items tab after a run. */
export function suggestionSummary(res: SuggestResponse): string {
  if (res.considered === 0) return "Every question already has a standard.";
  const withTags = res.suggestions.filter((s) => s.tags.length > 0).length;
  const head =
    withTags === 0
      ? `No standards matched ${questions(res.considered)} — try a different grade or paste this unit's standards list.`
      : `Suggested standards for ${withTags} of ${questions(res.considered)} without one. Accept or dismiss each.`;
  return res.left_out > 0
    ? `${head} ${questions(res.left_out)} left out — run again for the rest once these are tagged.`
    : head;
}

/** Chip text lookups go through /api/standards/lookup, at most 20 tags a call. */
export const LOOKUP_CHUNK = 20;

export type SuggestEntry = { code: string; text: string } | null;

export async function fetchSuggestionEntries(
  tags: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, SuggestEntry>> {
  const unique = [...new Set(tags)];
  const out: Record<string, SuggestEntry> = {};
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK);
    try {
      const res = await fetchFn(`/api/standards/lookup?tags=${encodeURIComponent(chunk.join(","))}`);
      const body = res.ok ? ((await res.json()) as { entries: Record<string, SuggestEntry> }) : null;
      for (const t of chunk) out[t] = body?.entries[t] ?? null;
    } catch {
      for (const t of chunk) out[t] = null;
    }
  }
  return out;
}
