// R-4 (docs/rubric-upload-design.md): the "Score with AI" button on a
// needs-manual card — the only UI path to a FIRST AI proposal for an
// `ai` / `hybrid` item. No testing-library / DOM harness exists in this repo
// (see test/delete-draft-button.test.tsx), so the branch is checked as the
// pure predicate the card renders through, plus the row's own static markup.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  offersAiScoring,
  queueBodyState,
  ScoreWithAiRow,
  ShortAnswerCredit,
} from "../app/dashboard/[id]/scoring/ScoringQueue";
import { TeacherFeedbackBox } from "../components/app/TeacherFeedbackBox";
import {
  TEACHER_FEEDBACK_ADMIN_HINT,
  TEACHER_FEEDBACK_HINT,
  TEACHER_FEEDBACK_MAX,
} from "../lib/teacherFeedback/limits";

function entry(
  scoring_method: string,
  proposed: unknown | null = null,
): { item: { scoring_method: string }; proposed: unknown | null } {
  return { item: { scoring_method }, proposed };
}

const aProposal = {
  score_id: "s1",
  points: 3,
  max_points: 4,
  rationale: null,
  scorer: "bedrock",
};

describe("offersAiScoring", () => {
  test("an ai item with no proposal offers a first AI score", () => {
    expect(offersAiScoring(entry("ai"))).toBe(true);
  });

  test("a hybrid item with no proposal offers one too", () => {
    expect(offersAiScoring(entry("hybrid"))).toBe(true);
  });

  test("a human item never offers one", () => {
    expect(offersAiScoring(entry("human"))).toBe(false);
  });

  test("an auto item never offers one", () => {
    expect(offersAiScoring(entry("auto"))).toBe(false);
  });

  test("an ai item that already has a proposal does not (the card shows Re-run AI)", () => {
    expect(offersAiScoring(entry("ai", aProposal))).toBe(false);
  });

  test("a hybrid item that already has a proposal does not", () => {
    expect(offersAiScoring(entry("hybrid", aProposal))).toBe(false);
  });
});

describe("ScoreWithAiRow", () => {
  test("renders the button label and the manual-scoring hint", () => {
    const html = renderToStaticMarkup(
      <ScoreWithAiRow busy={false} onClick={() => {}} />,
    );
    expect(html).toContain("Score with AI");
    expect(html).toContain("Or score it yourself below.");
    expect(html).not.toContain('disabled=""');
  });

  test("the button is disabled while another action is in flight", () => {
    const html = renderToStaticMarkup(
      <ScoreWithAiRow busy={true} onClick={() => {}} />,
    );
    expect(html).toContain('disabled=""');
  });
});

describe("ShortAnswerCredit (AI short answer, 2026-10-27)", () => {
  const rubric = {
    style: "holistic" as const,
    criteria: [
      {
        id: "sa",
        name: "Answer",
        levels: [
          { id: "a", label: "No credit", points: 0 },
          { id: "b", label: "Partial credit", points: 1, descriptor: "Names births." },
          { id: "c", label: "Full credit", points: 2, descriptor: "Births per 1000 people." },
        ],
      },
    ],
  };
  test("a short answer's card lists what earns each score", () => {
    const html = renderToStaticMarkup(<ShortAnswerCredit type="short_text" rubric={rubric} />);
    expect(html).toContain("Partial credit (1):");
    expect(html).toContain("Births per 1000 people.");
    expect(html).not.toContain("No credit");
  });
  test("an essay's card does not (its descriptors stay tooltips)", () => {
    expect(renderToStaticMarkup(<ShortAnswerCredit type="essay" rubric={rubric} />)).toBe("");
  });
  test("levels read lowest to highest whatever order they were stored in (row 838)", () => {
    const stored = { ...rubric, criteria: [{ ...rubric.criteria[0]!, levels: [...rubric.criteria[0]!.levels].reverse() }] };
    const html = renderToStaticMarkup(<ShortAnswerCredit type="short_text" rubric={stored} />);
    expect(html.indexOf("Partial credit")).toBeLessThan(html.indexOf("Full credit"));
  });
});

// Teacher feedback (docs/feedback-release-design.md, D-1 / D-4): the box on
// every queue card and on the per-student page. No DOM harness, so the save
// itself is a hand-run row; the markup it opens with is checked here.
describe("TeacherFeedbackBox", () => {
  test("opens on the saved text, labelled by source, capped, with Save disabled until edited", () => {
    const html = renderToStaticMarkup(
      <TeacherFeedbackBox endpoint="/api/responses/r1/feedback" initialText="Cite a source." />,
    );
    expect(html).toContain("Teacher feedback");
    expect(html).toContain(TEACHER_FEEDBACK_HINT);
    expect(html).toContain(">Cite a source.</textarea>");
    expect(html).toContain(`maxLength="${TEACHER_FEEDBACK_MAX}"`);
    expect(html).toContain("Save feedback");
    // Nothing to save until the text differs from what was saved.
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Not saved");
  });

  test("takes the overall label", () => {
    const html = renderToStaticMarkup(
      <TeacherFeedbackBox
        endpoint="/api/attempts/a1/feedback"
        initialText=""
        label="Teacher feedback (overall)"
      />,
    );
    expect(html).toContain("Teacher feedback (overall)");
  });

  test("read-only for a non-impersonating admin: grayed out, says why, keeps the text", () => {
    const html = renderToStaticMarkup(
      <TeacherFeedbackBox
        endpoint="/api/responses/r1/feedback"
        initialText="Cite a source."
        readOnly
      />,
    );
    expect(html).toContain(TEACHER_FEEDBACK_ADMIN_HINT);
    expect(html).not.toContain(TEACHER_FEEDBACK_HINT);
    expect(html).toContain(">Cite a source.</textarea>");
    // Both the textarea and the Save button are disabled.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  test("a writer's box leaves the textarea enabled", () => {
    const html = renderToStaticMarkup(
      <TeacherFeedbackBox endpoint="/api/responses/r1/feedback" initialText="" />,
    );
    // Only Save is disabled (nothing to save yet).
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});

// FR-H2 (hand-check row 866): scoring a card refetches the queue. The list
// must stay mounted through that refetch, or every TeacherFeedbackBox
// remounts from its saved text and an unsaved draft is lost.
describe("queueBodyState", () => {
  test("shows Loading… only before the first fetch is back", () => {
    expect(queueBodyState(false, 0, 0)).toBe("loading");
  });

  test("keeps the list during a refetch once the first fetch is back", () => {
    // `loaded` stays true while a later fetch runs, so cards are not swapped out.
    expect(queueBodyState(true, 2, 1)).toBe("list");
    expect(queueBodyState(true, 0, 1)).toBe("list");
  });

  test("an empty queue after loading says there is nothing to review", () => {
    expect(queueBodyState(true, 0, 0)).toBe("empty");
  });
});
