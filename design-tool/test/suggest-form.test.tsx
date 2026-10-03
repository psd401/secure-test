// BG slice 5: the pure logic behind "Suggest standards" and its chips. No DOM
// harness in this repo, so clicks stay manual rows (docs/design-tool-manual-checks.md).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SUGGEST_ITEM_CAP,
  SUGGEST_MAX_UNIT_LIST,
  buildSuggestFetchInit,
  buildSuggestRequest,
  canSuggest,
  describeSuggestError,
  emptySuggestForm,
  fetchSuggestionEntries,
  gradeBandLabel,
  needsCourse,
  removeSuggestion,
  suggestionCount,
  suggestionMapFrom,
  suggestionSummary,
  validateSuggestForm,
  type SuggestFormValues,
  type SuggestResponse,
} from "../lib/ai/suggestForm";
import {
  MAX_SUGGEST_UNIT_LIST_CHARS,
  SUGGEST_MAX_ITEMS,
  SUGGEST_SCHEMES,
  SUGGEST_SUBJECTS,
  SuggestStandardsRequest,
} from "../lib/ai/types";
import { SuggestStandardsDialog } from "../components/app/SuggestStandardsDialog";
import { StandardSuggestionChips } from "../components/app/StandardSuggestionChips";

const ID = "7b0d6f5e-7a39-4f3a-9a52-0d6a3b1c9e11";

function form(over: Partial<SuggestFormValues> = {}): SuggestFormValues {
  return { ...emptySuggestForm(), subject: "math", gradeBand: "7", ...over };
}

describe("limits mirror the route's", () => {
  test("constants and enums match lib/ai/types.ts", () => {
    expect(SUGGEST_MAX_UNIT_LIST).toBe(MAX_SUGGEST_UNIT_LIST_CHARS);
    expect(SUGGEST_ITEM_CAP).toBe(SUGGEST_MAX_ITEMS);
    expect([...SUGGEST_SUBJECTS]).toEqual(["math", "ela", "science"]);
    expect([...SUGGEST_SCHEMES]).toEqual(["wa2026", "ccss2010"]);
  });

  test("every request the form builds is accepted by the route's schema", () => {
    for (const v of [
      form(),
      form({ scheme: "ccss2010", unitList: "  7.RP.A.2  " }),
      form({ gradeBand: "HS", course: "Algebra 1" }),
      form({ subject: "science", gradeBand: "MS" }),
    ]) {
      const parsed = SuggestStandardsRequest.safeParse(buildSuggestRequest(ID, v));
      expect(parsed.success).toBe(true);
    }
  });
});

describe("validateSuggestForm", () => {
  test("subject and grade are required (no free-form suggestions)", () => {
    expect(validateSuggestForm(emptySuggestForm()).subject).toMatch(/subject/i);
    expect(validateSuggestForm(form({ gradeBand: "" })).gradeBand).toMatch(/grade/i);
    expect(canSuggest(form())).toBe(true);
    expect(canSuggest(emptySuggestForm())).toBe(false);
  });

  test("the pasted list is capped", () => {
    expect(canSuggest(form({ unitList: "x".repeat(SUGGEST_MAX_UNIT_LIST) }))).toBe(true);
    expect(validateSuggestForm(form({ unitList: "x".repeat(SUGGEST_MAX_UNIT_LIST + 1) })).unitList).toMatch(/too long/);
  });
});

describe("buildSuggestRequest", () => {
  test("blank list and course are absent; the course only rides with HS math", () => {
    expect(buildSuggestRequest(ID, form({ unitList: "   ", course: "Algebra 1" }))).toEqual({
      assessment_id: ID,
      subject: "math",
      grade_band: "7",
      scheme: "wa2026",
    });
    expect(buildSuggestRequest(ID, form({ gradeBand: "HS", course: "Algebra 1", unitList: " M.7 " }))).toEqual({
      assessment_id: ID,
      subject: "math",
      grade_band: "HS",
      course: "Algebra 1",
      scheme: "wa2026",
      unit_list: "M.7",
    });
  });

  test("science sends no scheme", () => {
    expect(buildSuggestRequest(ID, form({ subject: "science", gradeBand: "MS" }))).not.toHaveProperty("scheme");
  });

  test("JSON fetch init", () => {
    const init = buildSuggestFetchInit(ID, form());
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).assessment_id).toBe(ID);
  });

  test("needsCourse / gradeBandLabel", () => {
    expect(needsCourse({ subject: "math", gradeBand: "HS" })).toBe(true);
    expect(needsCourse({ subject: "science", gradeBand: "HS" })).toBe(false);
    expect(gradeBandLabel("K")).toBe("Kindergarten");
    expect(gradeBandLabel("7")).toBe("Grade 7");
    expect(gradeBandLabel("9-10")).toBe("9-10");
  });
});

describe("describeSuggestError", () => {
  test("plain words for each answer", () => {
    expect(describeSuggestError(403, { error: "llm_authoring_disabled" })).toMatch(/turned off/);
    expect(describeSuggestError(404, null)).toMatch(/no longer available/);
    expect(describeSuggestError(422, { error: "guardrail_blocked", note: "Edit it." })).toBe("Edit it.");
    expect(describeSuggestError(502, null)).toMatch(/try again/);
    expect(describeSuggestError(400, { detail: "no standards for that subject" })).toContain("no standards");
    expect(describeSuggestError(0, null)).toMatch(/Something went wrong/);
  });
});

const RES: SuggestResponse = {
  suggestions: [
    { item_id: "a", tags: [{ tag: "wa2026:X.1", reason: "r1" }, { tag: "wa2026:X.2", reason: "r2" }] },
    { item_id: "b", tags: [{ tag: "wa2026:X.1", reason: "r3" }] },
  ],
  considered: 5,
  left_out: 0,
};

describe("suggestion state", () => {
  test("map from the response; accept / dismiss remove one chip, and an emptied card goes", () => {
    let map = suggestionMapFrom(RES);
    expect(suggestionCount(map)).toBe(3);
    map = removeSuggestion(map, "a", "wa2026:X.1");
    expect(map.a!.map((t) => t.tag)).toEqual(["wa2026:X.2"]);
    map = removeSuggestion(map, "a", "wa2026:X.2");
    expect("a" in map).toBe(false);
    expect(removeSuggestion(map, "zzz", "q")).toBe(map);
    expect(suggestionCount(map)).toBe(1);
  });

  test("an item with no tags never gets a card entry", () => {
    expect(suggestionMapFrom({ suggestions: [{ item_id: "a", tags: [] }] })).toEqual({});
  });
});

describe("suggestionSummary", () => {
  test("says what happened in each case", () => {
    expect(suggestionSummary({ suggestions: [], considered: 0, left_out: 0 })).toBe(
      "Every question already has a standard.",
    );
    expect(suggestionSummary({ suggestions: [], considered: 3, left_out: 0 })).toMatch(/No standards matched 3 questions/);
    expect(suggestionSummary(RES)).toBe("Suggested standards for 2 of 5 questions without one. Accept or dismiss each.");
  });

  test("left-out items say to run again", () => {
    const s = suggestionSummary({ ...RES, considered: 40, left_out: 6 });
    expect(s).toContain("6 questions left out — run again for the rest");
    expect(suggestionSummary({ ...RES, considered: 1, left_out: 1 })).toContain("1 question left out");
  });
});

describe("fetchSuggestionEntries", () => {
  test("chunks by 20, dedupes, and a failed lookup is null", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const tags = decodeURIComponent(url.split("tags=")[1]!).split(",");
      if (calls.length === 2) return new Response("no", { status: 500 });
      return new Response(
        JSON.stringify({ entries: Object.fromEntries(tags.map((t) => [t, { code: t, text: "text" }])) }),
      );
    }) as unknown as typeof fetch;
    const tags = Array.from({ length: 25 }, (_, i) => `wa2026:T.${i}`);
    const out = await fetchSuggestionEntries([...tags, tags[0]!], fake);
    expect(calls).toHaveLength(2);
    expect(out["wa2026:T.0"]).toEqual({ code: "wa2026:T.0", text: "text" });
    expect(out["wa2026:T.24"]).toBeNull();
    expect(Object.keys(out)).toHaveLength(25);
  });
});

describe("markup", () => {
  test("<SuggestStandardsDialog> closed render is only the entry button", () => {
    const html = renderToStaticMarkup(<SuggestStandardsDialog assessmentId={ID} onSuggested={() => {}} />);
    expect(html).toContain("Suggest standards");
    expect(html).not.toContain("This unit");
  });

  test("<StandardSuggestionChips> shows code, reason, Accept and Dismiss; nothing when empty", () => {
    const html = renderToStaticMarkup(
      <StandardSuggestionChips
        suggestions={[{ tag: "wa2026:M.7.R.RP.2", reason: "Ratios in the stem." }]}
        entries={{ "wa2026:M.7.R.RP.2": { code: "M.7.R.RP.2", text: "Recognize proportional relationships." } }}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("M.7.R.RP.2");
    expect(html).toContain("Ratios in the stem.");
    expect(html).toContain("Accept");
    expect(html).toContain("Dismiss");
    expect(html).toContain("check before accepting");
    expect(
      renderToStaticMarkup(
        <StandardSuggestionChips suggestions={[]} entries={{}} onAccept={() => {}} onDismiss={() => {}} />,
      ),
    ).toBe("");
  });

  test("busy disables Accept but not Dismiss", () => {
    const html = renderToStaticMarkup(
      <StandardSuggestionChips
        suggestions={[{ tag: "wa2026:X.1", reason: "" }]}
        entries={{}}
        busy
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toMatch(/disabled=""[^>]*aria-label="Accept/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Dismiss/);
  });
});
