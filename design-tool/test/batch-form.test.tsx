// BG slice 4: the pure logic behind the "Generate questions" dialog. No DOM
// harness in this repo, so clicks stay manual rows (docs/design-tool-manual-checks.md).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BATCH_MAX_COUNT,
  BATCH_MAX_NOTES,
  BATCH_MAX_OBJECTIVE,
  BATCH_MAX_RESOURCE_CHARS,
  addAllSequentially,
  buildBatchFetchInit,
  buildBatchRequest,
  canGenerate,
  describeAddError,
  describeGenerateError,
  emptyBatchForm,
  hasProposedKey,
  keyText,
  matchColumns,
  needsKeyCheck,
  parseCount,
  proposalHeader,
  typeCountSum,
  validateBatchForm,
  type BatchFormValues,
  type BatchProposal,
} from "../lib/ai/batchForm";
import {
  BatchTypeCounts,
  GenerateItemsRequest,
  MAX_BATCH_COUNT,
  MAX_BATCH_NOTES_CHARS,
  MAX_BATCH_OBJECTIVE_CHARS,
  MAX_BATCH_RESOURCE_CHARS,
} from "../lib/ai/types";
import { MAX_UPLOAD_BYTES } from "../lib/ai/documentUpload";
import { BATCH_MAX_FILE_BYTES } from "../lib/ai/batchForm";
import { GenerateQuestionsDialog, MatchColumns } from "../components/app/GenerateQuestionsDialog";

const ID = "7b0d6f5e-7a39-4f3a-9a52-0d6a3b1c9e11";

function form(over: Partial<BatchFormValues> = {}): BatchFormValues {
  return { ...emptyBatchForm(), standards: ["wa2026:M.7.R.RP.2"], ...over };
}

describe("limits mirror the route's", () => {
  test("constants match lib/ai/types.ts and documentUpload.ts", () => {
    expect(BATCH_MAX_COUNT).toBe(MAX_BATCH_COUNT);
    expect(BATCH_MAX_OBJECTIVE).toBe(MAX_BATCH_OBJECTIVE_CHARS);
    expect(BATCH_MAX_NOTES).toBe(MAX_BATCH_NOTES_CHARS);
    expect(BATCH_MAX_RESOURCE_CHARS).toBe(MAX_BATCH_RESOURCE_CHARS);
    expect(BATCH_MAX_FILE_BYTES).toBe(MAX_UPLOAD_BYTES);
  });
});

describe("parseCount", () => {
  test("whole numbers 1..10 only", () => {
    expect(parseCount("5")).toBe(5);
    expect(parseCount(" 10 ")).toBe(10);
    for (const bad of ["0", "11", "", "2.5", "-1", "abc"]) expect(parseCount(bad)).toBeNull();
  });
});

describe("validateBatchForm", () => {
  test("the default form with one standard is valid", () => {
    expect(validateBatchForm(form())).toEqual({});
    expect(canGenerate(form())).toBe(true);
  });

  test("at least one of standards / objective / source / notes", () => {
    const empty = emptyBatchForm();
    expect(validateBatchForm(empty).focus).toBeTruthy();
    expect(canGenerate(empty)).toBe(false);
    expect(canGenerate({ ...empty, objective: "ratios" })).toBe(true);
    expect(canGenerate({ ...empty, notes: "x" })).toBe(true);
    expect(canGenerate({ ...empty, resourceText: "passage" })).toBe(true);
    expect(canGenerate({ ...empty, file: new File(["x"], "a.txt") })).toBe(true);
    expect(canGenerate({ ...empty, notes: "   " })).toBe(false);
  });

  test("a bad count is an error", () => {
    expect(validateBatchForm(form({ count: "11" })).count).toBeTruthy();
    expect(validateBatchForm(form({ count: "" })).count).toBeTruthy();
  });

  test("per-type counts must sum to How many", () => {
    const counts = (a: string, b: string, c: string, d: string) =>
      form({
        count: "5",
        typeMode: "counts",
        typeCounts: {
          multiple_choice_single: a,
          multiple_choice_multi: b,
          short_text: c,
          essay: d,
          match: "",
        },
      });
    expect(validateBatchForm(counts("2", "1", "1", "1"))).toEqual({});
    const off = validateBatchForm(counts("2", "1", "1", ""));
    expect(off.types).toContain("add up to 4");
    expect(canGenerate(counts("2", "1", "1", ""))).toBe(false);
    expect(validateBatchForm(counts("2", "x", "1", "1")).types).toBeTruthy();
    expect(typeCountSum(counts("2", "1", "1", ""))).toBe(4);
    // Mix ignores whatever is sitting in the count boxes.
    expect(validateBatchForm({ ...counts("9", "9", "9", "9"), typeMode: "mix" })).toEqual({});
  });

  test("a file and pasted text together are refused", () => {
    const both = form({ file: new File(["x"], "a.pdf"), resourceText: "text" });
    expect(validateBatchForm(both).resource).toBeTruthy();
    expect(canGenerate(both)).toBe(false);
  });

  test("length limits", () => {
    expect(validateBatchForm(form({ objective: "x".repeat(501) })).objective).toBeTruthy();
    expect(validateBatchForm(form({ notes: "x".repeat(2001) })).notes).toBeTruthy();
    expect(validateBatchForm(form({ resourceText: "x".repeat(200_001) })).resource).toBeTruthy();
  });
});

describe("buildBatchRequest", () => {
  test("standards only, mix: no resource / notes keys, passes the route's schema", () => {
    const body = buildBatchRequest(ID, form());
    expect(body).toEqual({
      assessment_id: ID,
      count: 5,
      types: "mix",
      target: { standards: ["wa2026:M.7.R.RP.2"] },
      difficulty: "mixed",
    });
    expect(GenerateItemsRequest.safeParse(body).success).toBe(true);
  });

  test("per-type counts drop zeros; objective, notes and pasted text are trimmed in", () => {
    const body = buildBatchRequest(
      ID,
      form({
        count: "3",
        typeMode: "counts",
        typeCounts: {
          multiple_choice_single: "2",
          multiple_choice_multi: "0",
          short_text: "",
          essay: "1",
          match: "",
        },
        standards: [],
        objective: "  compare ratios ",
        notes: " keep it short ",
        resourceText: " a passage ",
        difficulty: "harder",
      }),
    );
    expect(body).toEqual({
      assessment_id: ID,
      count: 3,
      types: { multiple_choice_single: 2, essay: 1 },
      target: { objective: "compare ratios" },
      difficulty: "harder",
      notes: "keep it short",
      resource: { text: "a passage" },
    });
    const parsed = GenerateItemsRequest.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(BatchTypeCounts.safeParse((body as { types: object }).types).success).toBe(true);
  });

  test("a file goes multipart: a `request` JSON field plus `file`, no resource key", async () => {
    const file = new File(["%PDF"], "unit.pdf", { type: "application/pdf" });
    const init = buildBatchFetchInit(ID, form({ file }));
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined(); // the browser sets the multipart boundary
    const fd = init.body as FormData;
    const request = JSON.parse(fd.get("request") as string);
    expect(request.resource).toBeUndefined();
    expect(request.assessment_id).toBe(ID);
    expect((fd.get("file") as File).name).toBe("unit.pdf");
  });

  test("no file goes JSON", () => {
    const init = buildBatchFetchInit(ID, form());
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string).count).toBe(5);
  });
});

describe("describeGenerateError", () => {
  test("maps every status the route answers", () => {
    expect(describeGenerateError(403, { error: "llm_authoring_disabled" })).toContain("turned off");
    expect(describeGenerateError(413, null)).toContain("5 MB");
    expect(describeGenerateError(415, { hint: "Upload a PDF." })).toBe("Upload a PDF.");
    expect(describeGenerateError(415, null)).toContain("PDF");
    expect(
      describeGenerateError(422, { error: "guardrail_blocked", note: "Edit the notes." }),
    ).toBe("Edit the notes.");
    expect(describeGenerateError(502, { error: "provider_failed" })).toBe(
      "The AI couldn't produce questions — try again or change the request.",
    );
    expect(describeGenerateError(400, { detail: "count: too big" })).toContain("count: too big");
    expect(describeGenerateError(500, null)).toContain("Something went wrong");
  });
});

describe("proposals", () => {
  const mc: BatchProposal = {
    type: "multiple_choice_single",
    stem: "Which?",
    choices: [
      { id: "a", text: "Red" },
      { id: "b", text: "Blue" },
    ],
    correct_choice_ids: ["b"],
  };
  const sa: BatchProposal = { type: "short_text", stem: "Name it", correct_answer: "x" };
  const essay: BatchProposal = { type: "essay", stem: "Discuss." };

  test("the key badge applies to keyed types until the card's key is opened", () => {
    expect(hasProposedKey(mc)).toBe(true);
    expect(hasProposedKey(sa)).toBe(true);
    expect(hasProposedKey(essay)).toBe(false);
    expect(needsKeyCheck(mc, new Set(), "c1")).toBe(true);
    expect(needsKeyCheck(mc, new Set(["c1"]), "c1")).toBe(false);
    expect(needsKeyCheck(mc, new Set(["c2"]), "c1")).toBe(true);
    expect(needsKeyCheck(essay, new Set(), "c1")).toBe(false);
  });

  test("keyText reads the correct choices or the short answer", () => {
    expect(keyText(mc)).toEqual(["Blue"]);
    expect(keyText(sa)).toEqual(["x"]);
    expect(keyText(essay)).toEqual([]);
  });

  test("header counts ready questions and dropped ones", () => {
    expect(proposalHeader(5, 0)).toBe("5 questions ready");
    expect(proposalHeader(1, 0)).toBe("1 question ready");
    expect(proposalHeader(4, 1)).toBe("4 questions ready · 1 couldn't be used");
  });
});

describe("addAllSequentially", () => {
  test("adds in order and stops at the first failure, reporting what landed", async () => {
    const seen: string[] = [];
    const result = await addAllSequentially(["a", "b", "c", "d"], async (id) => {
      seen.push(id);
      if (id === "c") throw new Error("HTTP 409");
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ ok: false, added: ["a", "b"], failedId: "c", message: "HTTP 409" });
  });

  test("all succeed", async () => {
    expect(await addAllSequentially(["a", "b"], async () => {})).toEqual({
      ok: true,
      added: ["a", "b"],
    });
  });
});

describe("<GenerateQuestionsDialog> closed render", () => {
  test("renders only the entry button", () => {
    const html = renderToStaticMarkup(
      <GenerateQuestionsDialog assessmentId={ID} usedStandards={[]} onAdded={() => {}} />,
    );
    expect(html).toContain("Generate questions");
    expect(html).not.toContain("How many questions");
  });
});

describe("describeAddError", () => {
  test("a Publish mid Add all reads in words, not as the error code (row 367)", () => {
    const msg = describeAddError(409, { error: "assessment_published_editing_locked" });
    expect(msg).toContain("the assessment was published");
    expect(msg).not.toContain("assessment_published_editing_locked");
    expect(describeAddError(404, null)).toContain("no longer available");
    expect(describeAddError(400, { detail: "stem: Required" })).toContain("stem: Required");
    expect(describeAddError(500, null)).toContain("Try again");
  });
});

// BG slice 6 (D-7): match by count, keyed by structure.
describe("match proposals", () => {
  const match: BatchProposal = {
    type: "match",
    stem: "Match each element to its symbol.",
    pairs: [
      { id: "p1", left: "Sodium", right: "Na" },
      { id: "p2", left: "Potassium", right: "K" },
      { id: "p3", left: "Iron", right: "Fe" },
    ],
  };

  test("Matching is a type box; its count joins the sum and the request", () => {
    const v = form({
      count: "3",
      typeMode: "counts",
      typeCounts: { ...emptyBatchForm().typeCounts, match: "2", essay: "1" },
    });
    expect(typeCountSum(v)).toBe(3);
    expect(validateBatchForm(v)).toEqual({});
    const body = buildBatchRequest(ID, v);
    expect(body.types).toEqual({ essay: 1, match: 2 });
    expect(GenerateItemsRequest.safeParse(body).success).toBe(true);
  });

  test("the pairing is the key: badge until opened, key reads left → right", () => {
    expect(hasProposedKey(match)).toBe(true);
    expect(needsKeyCheck(match, new Set(), "c1")).toBe(true);
    expect(needsKeyCheck(match, new Set(["c1"]), "c1")).toBe(false);
    expect(keyText(match)).toEqual(["Sodium → Na", "Potassium → K", "Iron → Fe"]);
  });

  test("before the key, columns show apart: lefts in order, rights sorted", () => {
    expect(matchColumns(match)).toEqual({
      lefts: ["Sodium", "Potassium", "Iron"],
      rights: ["Fe", "K", "Na"],
    });
    const html = renderToStaticMarkup(<MatchColumns proposal={match} />);
    expect(html).toContain("Right column (sorted)");
    expect(html.indexOf(">Fe<")).toBeLessThan(html.indexOf(">Na<"));
    expect(html).not.toContain("→");
  });
});
