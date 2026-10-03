// Instant feedback slice 2: the pure wording / rules behind the Settings
// control and the Release answers button, plus static markup of both. No DOM
// harness here, so clicks (the PATCH on change, the confirm + POST) stay
// manual rows (docs/design-tool-manual-checks.md).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANSWERS_RELEASE_OPTIONS,
  FEEDBACK_LEVEL_OPTIONS,
  RELEASE_CONFIRM_BODY,
  canReleaseAnswers,
  feedbackLevelLine,
  feedbackSettingsBody,
  releaseErrorMessage,
  releasedLine,
  showsAnswersReleaseChoice,
  showsReleasedLine,
} from "../lib/feedback/settingsUi";
import { isFeedbackSettingsOnlyPatch } from "../lib/api/requireDraft";
import { InstantFeedbackSettings } from "../components/app/InstantFeedbackSettings";
import { ReleaseAnswersControl } from "../components/app/ReleaseAnswersControl";
import type { AssessmentRow } from "../db/schema";

const ID = "7b0d6f5e-7a39-4f3a-9a52-0d6a3b1c9e11";

describe("settings wording", () => {
  test("four levels in order, each with a line; the selects match the schema values", () => {
    expect(FEEDBACK_LEVEL_OPTIONS.map((o) => o.value)).toEqual([
      "off",
      "score",
      "right_wrong",
      "answers",
    ]);
    for (const o of FEEDBACK_LEVEL_OPTIONS) expect(feedbackLevelLine(o.value)).toBe(o.line);
    expect(feedbackLevelLine("score")).toContain("You scored 14 of 18");
    expect(feedbackLevelLine("nonsense")).toBe("");
    expect(ANSWERS_RELEASE_OPTIONS.map((o) => o.value)).toEqual(["on_release", "at_hand_in"]);
  });

  test("the release choice only matters at the answers level", () => {
    expect(showsAnswersReleaseChoice("answers")).toBe(true);
    for (const l of ["off", "score", "right_wrong"]) expect(showsAnswersReleaseChoice(l)).toBe(false);
  });

  test("the release button: answers + on_release + not yet released, nothing else", () => {
    expect(canReleaseAnswers("answers", "on_release", null)).toBe(true);
    expect(canReleaseAnswers("answers", "on_release", "2026-10-03T17:00:00Z")).toBe(false);
    expect(canReleaseAnswers("answers", "at_hand_in", null)).toBe(false);
    expect(canReleaseAnswers("right_wrong", "on_release", null)).toBe(false);
    expect(canReleaseAnswers("off", "on_release", null)).toBe(false);
  });

  test("the released line shows once stamped, at the answers level only", () => {
    expect(showsReleasedLine("answers", "2026-10-03T17:00:00Z")).toBe(true);
    expect(showsReleasedLine("answers", null)).toBe(false);
    expect(showsReleasedLine("score", "2026-10-03T17:00:00Z")).toBe(false);
    // 17:00Z on 3 Oct 2026 is 10:00 AM Pacific.
    expect(releasedLine("2026-10-03T17:00:00Z")).toMatch(/^Answers released Oct 3(,| at) 10:00 AM$/);
  });

  test("the confirm copy carries the earlier-hand-in caveat", () => {
    expect(RELEASE_CONFIRM_BODY).toContain("from now on");
    expect(RELEASE_CONFIRM_BODY).toContain("already handed in will not see them in the app");
  });

  test("release errors read plainly; an unknown code is surfaced for IT", () => {
    expect(releaseErrorMessage("not_answers_level")).toContain("Correct answers");
    expect(releaseErrorMessage("network")).toContain("Couldn't reach the server");
    expect(releaseErrorMessage("http_500")).toContain("http_500");
  });
});

describe("the settings PATCH body", () => {
  const published = {
    id: ID,
    status: "published",
    name: "Quiz",
    description: "",
    time_limit_seconds: null,
    student_feedback: "off",
    answers_release: "on_release",
  } as unknown as AssessmentRow;

  test("carries only the two feedback keys", () => {
    expect(Object.keys(feedbackSettingsBody("answers", "at_hand_in")).sort()).toEqual([
      "answers_release",
      "student_feedback",
    ]);
  });

  test("a Published assessment's lock admits it when a setting changes", () => {
    expect(isFeedbackSettingsOnlyPatch(feedbackSettingsBody("answers", "on_release"), published)).toBe(
      true,
    );
    expect(isFeedbackSettingsOnlyPatch(feedbackSettingsBody("off", "at_hand_in"), published)).toBe(true);
  });

  test("an unchanged pair is a no-op, not a way through the lock", () => {
    expect(isFeedbackSettingsOnlyPatch(feedbackSettingsBody("off", "on_release"), published)).toBe(false);
  });
});

describe("static markup", () => {
  test("settings: select with four options; no release choice at off", () => {
    const html = renderToStaticMarkup(
      <InstantFeedbackSettings
        assessmentId={ID}
        initialLevel="off"
        initialRelease="on_release"
        initialReleasedAt={null}
      />,
    );
    expect(html).toContain("Instant feedback at hand-in");
    for (const o of FEEDBACK_LEVEL_OPTIONS) expect(html).toContain(o.label);
    expect(html).not.toContain("Show correct answers");
    expect(html).not.toContain("Release answers");
    // The control is never locked while Published: the select carries no
    // disabled attribute on first render.
    expect(html).not.toContain('disabled=""');
  });

  test("settings: answers + on_release shows the release choice and the button", () => {
    const html = renderToStaticMarkup(
      <InstantFeedbackSettings
        assessmentId={ID}
        initialLevel="answers"
        initialRelease="on_release"
        initialReleasedAt={null}
      />,
    );
    expect(html).toContain("Show correct answers");
    expect(html).toContain("After I release them");
    expect(html).toContain("Release answers");
    expect(html).toContain("not when you hand in for them");
  });

  test("settings: released shows the line instead of the button", () => {
    const html = renderToStaticMarkup(
      <InstantFeedbackSettings
        assessmentId={ID}
        initialLevel="answers"
        initialRelease="on_release"
        initialReleasedAt="2026-10-03T17:00:00Z"
      />,
    );
    expect(html).toContain(releasedLine("2026-10-03T17:00:00Z"));
    expect(html).not.toContain("<button");
  });

  test("settings: at hand-in has no button and no released line until stamped", () => {
    const html = renderToStaticMarkup(
      <InstantFeedbackSettings
        assessmentId={ID}
        initialLevel="answers"
        initialRelease="at_hand_in"
        initialReleasedAt={null}
      />,
    );
    expect(html).not.toContain("Release answers");
    expect(html).not.toContain("Answers released");
  });

  test("release control: button when unreleased, line when released", () => {
    const button = renderToStaticMarkup(
      <ReleaseAnswersControl assessmentId={ID} releasedAt={null} />,
    );
    expect(button).toContain("Release answers");
    const line = renderToStaticMarkup(
      <ReleaseAnswersControl assessmentId={ID} releasedAt="2026-10-03T17:00:00Z" />,
    );
    expect(line).toContain(releasedLine("2026-10-03T17:00:00Z"));
    expect(line).not.toContain("<button");
  });
});
