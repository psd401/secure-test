// Rubric upload slice 2 (docs/rubric-upload-design.md §"The editor dialog").
// No testing-library / DOM harness exists in this repo (see
// test/error-boundaries.test.tsx, test/delete-draft-button.test.tsx) — the
// component's initial-render posture is checked with
// react-dom/server's renderToStaticMarkup (same as those files), and the
// interactive pieces (extract, error mapping, apply-and-merge) are checked
// by calling the component's own exported, pure/async logic directly rather
// than simulating clicks through a DOM that isn't wired up here. `fetch` is
// stubbed via a plain `globalThis.fetch` assignment, restored in afterEach —
// bun's `mock.module` leaks across files in this repo (rubric-extract-route
// test's header comment; essay-scorer.test.ts's snapshot gotcha).
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Rubric } from "@secure-test/schema";
import {
  RubricProposalView,
  canExtract,
  describeExtractError,
  mergeRubricProposal,
  runRubricExtract,
} from "../app/dashboard/[id]/RubricUploadDialog";
import { RubricEditor, isDefaultRubric, defaultRubric } from "../app/dashboard/[id]/RubricEditor";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROPOSED_RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "c1",
      name: "Claim",
      levels: [
        { id: "l1", label: "Strong", points: 3, descriptor: "Clear claim" },
        { id: "l2", label: "Weak", points: 0 },
      ],
    },
  ],
};

const WARNINGS = [
  { code: "points_assigned" as const, message: "Points were not printed for every level." },
  { code: "style_guess" as const, message: "The rubric's style was not stated." },
];

describe("canExtract", () => {
  test("disabled with neither a file nor text", () => {
    expect(canExtract(null, "")).toBe(false);
    expect(canExtract(null, "   ")).toBe(false);
  });
  test("enabled with a file only", () => {
    expect(canExtract(new File(["x"], "r.pdf"), "")).toBe(true);
  });
  test("enabled with pasted text only", () => {
    expect(canExtract(null, "Claim | Evidence")).toBe(true);
  });
});

describe("RubricEditor's initial render", () => {
  test("shows Upload rubric… beside + Add rubric before any rubric exists", () => {
    const html = renderToStaticMarkup(
      <RubricEditor value={null} onChange={() => {}} assessmentId="a1" />,
    );
    expect(html).toContain("+ Add rubric");
    expect(html).toContain("Upload rubric");
  });

  test("shows Upload rubric… beside the style select once a rubric exists", () => {
    const html = renderToStaticMarkup(
      <RubricEditor value={defaultRubric()} onChange={() => {}} assessmentId="a1" />,
    );
    expect(html).toContain("Rubric style:");
    expect(html).toContain("Upload rubric");
  });
});

describe("runRubricExtract", () => {
  test("success: posts JSON text and returns the rubric + warnings", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return jsonResponse(200, { ok: true, rubric: PROPOSED_RUBRIC, warnings: WARNINGS });
    }) as typeof fetch;

    const outcome = await runRubricExtract("assess-1", { file: null, text: "Claim | Evidence" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.rubric).toEqual(PROPOSED_RUBRIC);
      expect(outcome.warnings).toEqual(WARNINGS);
    }
    expect(calledUrl).toBe("/api/assessments/assess-1/rubrics/extract");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ text: "Claim | Evidence" });
  });

  test("a file wins over text when both are present", async () => {
    let bodyWasFormData = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodyWasFormData = init?.body instanceof FormData;
      return jsonResponse(200, { ok: true, rubric: PROPOSED_RUBRIC, warnings: [] });
    }) as typeof fetch;

    await runRubricExtract("assess-1", {
      file: new File(["rubric bytes"], "r.pdf", { type: "application/pdf" }),
      text: "ignored",
    });
    expect(bodyWasFormData).toBe(true);
  });

  test("error body: hint + issues pass through", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      jsonResponse(422, {
        ok: false,
        error: "rubric_extract_invalid_output",
        hint: "The AI could not read a rubric out of this.",
        issues: ["criteria: at least one criterion with at least one level is required"],
      })) as typeof fetch;

    const outcome = await runRubricExtract("assess-1", { file: null, text: "garbage" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toBe("The AI could not read a rubric out of this.");
      expect(outcome.issues).toEqual([
        "criteria: at least one criterion with at least one level is required",
      ]);
    }
  });

  test("a body that fails to parse falls back to a generic message", async () => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response("not json", { status: 500 })) as typeof fetch;
    const outcome = await runRubricExtract("assess-1", { file: null, text: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toBe("Could not read the rubric.");
  });
});

describe("describeExtractError", () => {
  test("413 → the fixed over-5MB message, regardless of body", () => {
    expect(describeExtractError(413, { hint: "ignored" }).message).toBe(
      "The file is over 5 MB.",
    );
  });
  test("409 → the fixed unpublish message", () => {
    expect(describeExtractError(409, null).message).toBe(
      "Unpublish the assessment to change rubrics.",
    );
  });
  test("415 → the route's own hint", () => {
    const { message } = describeExtractError(415, {
      hint: "Upload a PDF, a Word document (.docx), Markdown or a plain-text file.",
    });
    expect(message).toBe("Upload a PDF, a Word document (.docx), Markdown or a plain-text file.");
  });
  test("no hint at all → the generic fallback, no issues key", () => {
    const result = describeExtractError(502, null);
    expect(result.message).toBe("Could not read the rubric.");
    expect(result.issues).toBeUndefined();
  });
});

describe("RubricProposalView", () => {
  test("renders every warning and the criterion/level table, single_point column reads Target", () => {
    const html = renderToStaticMarkup(
      <RubricProposalView rubric={PROPOSED_RUBRIC} warnings={WARNINGS} />,
    );
    expect(html).toContain("Points were not printed for every level.");
    // renderToStaticMarkup HTML-escapes text nodes — check for the escaped
    // apostrophe rather than the literal message string.
    expect(html).toContain("The rubric&#x27;s style was not stated.");
    expect(html).toContain("Claim");
    expect(html).toContain("Strong");
    expect(html).toContain("Clear claim");
    expect(html).toContain("(3 pts)");
    expect(html).toContain("(0 pts)");

    const singlePoint: Rubric = {
      style: "single_point",
      criteria: [{ id: "c1", name: "Focus", levels: [{ id: "l1", label: "On target", points: 1 }] }],
    };
    const spHtml = renderToStaticMarkup(<RubricProposalView rubric={singlePoint} warnings={[]} />);
    expect(spHtml).toContain(">Target ");
    expect(spHtml).not.toContain("On target");
  });

  test("no warnings → no warnings list rendered", () => {
    const html = renderToStaticMarkup(<RubricProposalView rubric={PROPOSED_RUBRIC} warnings={[]} />);
    expect(html).not.toContain('aria-label="Warnings"');
  });
});

describe("mergeRubricProposal (\"Use this rubric\" apply logic)", () => {
  test("keeps the editor's existing student_visibility over the proposal's (none)", () => {
    const current: Rubric = {
      ...defaultRubric(),
      student_visibility: { during_test: true, with_feedback: true },
    };
    const merged = mergeRubricProposal(current, PROPOSED_RUBRIC);
    expect(merged.student_visibility).toEqual({ during_test: true, with_feedback: true });
    // Everything else comes from the proposal, not the old rubric.
    expect(merged.criteria).toEqual(PROPOSED_RUBRIC.criteria);
    expect(merged.style).toBe(PROPOSED_RUBRIC.style);
  });

  test("no current rubric → the proposal is used as-is (no visibility to preserve)", () => {
    const merged = mergeRubricProposal(null, PROPOSED_RUBRIC);
    expect(merged).toEqual(PROPOSED_RUBRIC);
  });
});

describe("isDefaultRubric", () => {
  test("the pristine + Add rubric shape is default", () => {
    expect(isDefaultRubric(defaultRubric())).toBe(true);
  });
  test("a renamed criterion is no longer default", () => {
    const r = defaultRubric();
    r.criteria[0]!.name = "Argumentation";
    expect(isDefaultRubric(r)).toBe(false);
  });
  test("an authored rubric (extra criterion) is not default", () => {
    const r = defaultRubric();
    r.criteria.push({ id: "c2", name: "Evidence", levels: r.criteria[0]!.levels });
    expect(isDefaultRubric(r)).toBe(false);
  });
});
