// Rubric library slice 3 (docs/rubric-upload-design.md §"Rubric library and
// reuse", D-4), the editor half: "Save to my rubrics" on the upload
// proposal, "Use a saved rubric…" and its copy-with-fresh-ids, and the
// `meta.rubric_id` that carries provenance back to the item's PATCH body.
//
// Same posture as test/rubric-upload-dialog.test.tsx: no DOM harness exists
// in this repo, so the component's exported logic is called directly and the
// initial render is checked with renderToStaticMarkup. `fetch` is stubbed by
// plain `globalThis.fetch` assignment, restored in afterEach — bun's
// `mock.module` leaks across files here.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Rubric } from "@secure-test/schema";
import {
  SavedRubricsDialog,
  copyRubricForEditor,
  describeSavedRubric,
  fetchSavedRubric,
  fetchSavedRubrics,
  type SavedRubricSummary,
} from "../app/dashboard/[id]/SavedRubricsDialog";
import {
  defaultRubricTitle,
  saveRubricToLibrary,
} from "../app/dashboard/[id]/RubricUploadDialog";
import { itemConfigForWrite } from "../lib/api/items";

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

const SAVED: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "lib-a",
      name: "Claim",
      levels: [
        { id: "lib-a-1", label: "Strong", points: 3, descriptor: "Clear claim" },
        { id: "lib-a-2", label: "Weak", points: 0 },
      ],
    },
    {
      id: "lib-b",
      name: "Evidence",
      levels: [
        { id: "lib-b-1", label: "Strong", points: 2 },
        { id: "lib-b-2", label: "Weak", points: 0 },
      ],
    },
  ],
  student_visibility: { during_test: true, with_feedback: true },
};

const SUMMARY: SavedRubricSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Argument rubric",
  style: "analytic",
  criteria_count: 2,
  max_points: 5,
  source: "upload",
  updated_at: "2026-09-11T00:00:00.000Z",
};

describe("copyRubricForEditor", () => {
  test("assigns fresh c1…/l1… ids, unique across the rubric", () => {
    const copy = copyRubricForEditor(SAVED, null);
    expect(copy.criteria.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(copy.criteria.flatMap((c) => c.levels.map((l) => l.id))).toEqual([
      "l1",
      "l2",
      "l3",
      "l4",
    ]);
  });

  test("keeps every label, point value and descriptor", () => {
    const copy = copyRubricForEditor(SAVED, null);
    expect(copy.style).toBe("analytic");
    expect(copy.criteria.map((c) => c.name)).toEqual(["Claim", "Evidence"]);
    expect(copy.criteria[0]!.levels[0]).toMatchObject({
      label: "Strong",
      points: 3,
      descriptor: "Clear claim",
    });
    // An absent descriptor stays absent rather than becoming "".
    expect(copy.criteria[0]!.levels[1]!.descriptor).toBeUndefined();
  });

  test("keeps the editor's own student_visibility, not the library's", () => {
    const current: Rubric = {
      style: "analytic",
      criteria: SAVED.criteria,
      student_visibility: { during_test: false, with_feedback: false },
    };
    const copy = copyRubricForEditor(SAVED, current);
    expect(copy.student_visibility).toEqual({ during_test: false, with_feedback: false });
  });

  test("falls back to the saved rubric's visibility when the editor had none", () => {
    const copy = copyRubricForEditor(SAVED, null);
    expect(copy.student_visibility).toEqual({ during_test: true, with_feedback: true });
  });

  test("the copy shares no object identity with the library rubric", () => {
    const copy = copyRubricForEditor(SAVED, null);
    copy.criteria[0]!.name = "Edited";
    expect(SAVED.criteria[0]!.name).toBe("Claim");
  });
});

describe("describeSavedRubric", () => {
  test("style, criteria count and max points on one line", () => {
    expect(describeSavedRubric(SUMMARY)).toBe("Analytic · 2 criteria · 5 pts");
  });

  test("singular forms", () => {
    expect(
      describeSavedRubric({ ...SUMMARY, style: "single_point", criteria_count: 1, max_points: 1 }),
    ).toBe("Single-point · 1 criterion · 1 pt");
  });
});

describe("fetchSavedRubrics / fetchSavedRubric", () => {
  test("the list returns the summaries", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { rubrics: [SUMMARY] })) as unknown as typeof fetch;
    const outcome = await fetchSavedRubrics();
    expect(outcome).toEqual({ ok: true, rubrics: [SUMMARY] });
  });

  test("a failed list reports rather than throwing", async () => {
    globalThis.fetch = (async () => jsonResponse(500, { ok: false })) as unknown as typeof fetch;
    const outcome = await fetchSavedRubrics();
    expect(outcome.ok).toBe(false);
  });

  test("one rubric is unwrapped from its row", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { rubric: { id: SUMMARY.id, rubric: SAVED } })) as unknown as typeof fetch;
    const outcome = await fetchSavedRubric(SUMMARY.id);
    expect(outcome).toEqual({ ok: true, rubric: SAVED });
  });

  test("a 404 reports rather than throwing", async () => {
    globalThis.fetch = (async () => jsonResponse(404, { ok: false })) as unknown as typeof fetch;
    const outcome = await fetchSavedRubric(SUMMARY.id);
    expect(outcome.ok).toBe(false);
  });
});

describe("saveRubricToLibrary", () => {
  test("POSTs the title and rubric with source upload, and returns the new id", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(201, { rubric: { id: SUMMARY.id } });
    }) as unknown as typeof fetch;

    const outcome = await saveRubricToLibrary("Argument rubric", SAVED);
    expect(outcome).toEqual({ ok: true, id: SUMMARY.id });
    expect(calls[0]!.url).toBe("/api/rubrics");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      title: "Argument rubric",
      rubric: SAVED,
      source: "upload",
    });
  });

  test("a failure surfaces the route's hint", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, { ok: false, hint: "That title is too long." })) as unknown as typeof fetch;
    const outcome = await saveRubricToLibrary("x".repeat(300), SAVED);
    expect(outcome).toEqual({ ok: false, message: "That title is too long." });
  });
});

describe("defaultRubricTitle", () => {
  test("the file name without its extension", () => {
    expect(defaultRubricTitle(new File(["x"], "Argument Rubric.docx"))).toBe("Argument Rubric");
  });

  test("no file (the paste path) falls back to Rubric", () => {
    expect(defaultRubricTitle(null)).toBe("Rubric");
  });

  test("a name that is only an extension falls back too", () => {
    expect(defaultRubricTitle(new File(["x"], ".pdf"))).toBe("Rubric");
  });
});

describe("the meta the editor hands on", () => {
  test("applying a saved rubric attaches it; a hand edit detaches", () => {
    // The client-side half of the detach rule: RubricEditor's onChange gets
    // meta only on an apply, and AssessmentEditor writes
    // `rubric_id: meta?.rubric_id ?? null` — so an item's stored config
    // follows the server's rule below either way.
    const applied = itemConfigForWrite({
      type: "essay",
      stem: "Write an argument.",
      choices: [],
      correct_choice_ids: [],
      rubric: SAVED,
      rubric_id: SUMMARY.id,
    } as never);
    expect(applied.rubric_id).toBe(SUMMARY.id);

    const handEdited = itemConfigForWrite(
      {
        type: "essay",
        stem: "Write an argument.",
        choices: [],
        correct_choice_ids: [],
        rubric: { ...SAVED, criteria: [SAVED.criteria[0]!] },
        rubric_id: null,
      } as never,
      { rubric: SAVED, rubric_id: SUMMARY.id },
    );
    expect(handEdited.rubric_id).toBeUndefined();
    expect(handEdited.rubric).toEqual({ ...SAVED, criteria: [SAVED.criteria[0]!] });
  });

  test("an unchanged rubric keeps its attachment even with keys re-ordered", () => {
    // The stored copy comes back from jsonb in insertion order; the editor
    // sends its own. Content, not key order, decides.
    const reordered = JSON.parse(
      JSON.stringify({
        criteria: SAVED.criteria,
        student_visibility: SAVED.student_visibility,
        style: SAVED.style,
      }),
    ) as Rubric;
    const config = itemConfigForWrite(
      {
        type: "essay",
        stem: "Write an argument.",
        choices: [],
        correct_choice_ids: [],
        rubric: reordered,
      } as never,
      { rubric: SAVED, rubric_id: SUMMARY.id },
    );
    expect(config.rubric_id).toBe(SUMMARY.id);
  });
});

describe("SavedRubricsDialog initial render", () => {
  test("shows its trigger and nothing else until it is opened", () => {
    const html = renderToStaticMarkup(
      <SavedRubricsDialog currentRubric={null} onApply={() => {}} />,
    );
    expect(html).toContain("Use a saved rubric…");
    expect(html).not.toContain("Your saved rubrics");
  });

  test("the trigger honours disabled", () => {
    const html = renderToStaticMarkup(
      <SavedRubricsDialog currentRubric={null} onApply={() => {}} disabled />,
    );
    expect(html).toContain("disabled");
  });
});
