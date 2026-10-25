// Roadmap U-24 (docs/batch-ai-scoring-design.md), slice 1 UI half: "Score
// essays with AI" on the Results page. Static markup + the pure copy and pool,
// as in hand-in-in-progress-control — no DOM harness exists here; the click
// and the progress are hand-run rows.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addToTally,
  EMPTY_TALLY,
  outcomeForStatus,
  REFUSED,
  runPool,
  ScoreEssaysWithAiControl,
  scoreEssaysDialogCopy,
  scoreEssaysDisabledReason,
  scoreEssaysLabel,
  scoreEssaysSummary,
} from "../components/app/ScoreEssaysWithAiControl";

describe("ScoreEssaysWithAiControl", () => {
  test("enabled with the count when a section is chosen", () => {
    const html = renderToStaticMarkup(
      <ScoreEssaysWithAiControl
        attemptIds={["a", "b"]}
        essayCount={3}
        sectionLabel="P2 English"
        onFinished={() => {}}
      />,
    );
    expect(html).toContain(scoreEssaysLabel(3));
    expect(html).not.toContain('disabled=""');
  });

  test("D-2: disabled with no section chosen, the count still shown", () => {
    const html = renderToStaticMarkup(
      <ScoreEssaysWithAiControl
        attemptIds={["a"]}
        essayCount={1}
        sectionLabel={null}
        onFinished={() => {}}
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("Choose a section first.");
    expect(html).toContain("Score essays with AI (1)");
  });

  test("disabled at zero in a section", () => {
    expect(scoreEssaysDisabledReason(0, true)).toBe(
      "No essays in this section are waiting for an AI score.",
    );
    expect(scoreEssaysDisabledReason(2, true)).toBeUndefined();
  });

  test("the dialog copy names essays, students and the section", () => {
    expect(scoreEssaysDialogCopy(1, 1, "P2 English")).toStartWith(
      "Score 1 essay from 1 student in P2 English with AI?",
    );
    expect(scoreEssaysDialogCopy(5, 4, "P3")).toContain("Keep this page open");
  });
});

describe("tally and summary", () => {
  test("adds route counts and failed requests", () => {
    let t = EMPTY_TALLY;
    t = addToTally(t, {
      ok: true,
      scored_proposed: 1,
      scored_final: 1,
      withheld: 0,
    });
    t = addToTally(t, {
      ok: true,
      scored_proposed: 2,
      blocked: 1,
      provider_errors: 1,
      in_progress: 1,
    });
    t = addToTally(t, null);
    expect(t).toEqual({
      scored_proposed: 3,
      scored_final: 1,
      withheld: 0,
      screening_failed: 0,
      blocked: 1,
      provider_errors: 1,
      skipped_unscorable: 0,
      in_progress: 1,
      failed_students: 1,
      refused_students: 0,
    });
  });

  test("one line per non-zero outcome, in the note's order", () => {
    expect(
      scoreEssaysSummary({
        scored_proposed: 18,
        scored_final: 6,
        withheld: 2,
        screening_failed: 1,
        blocked: 1,
        provider_errors: 1,
        skipped_unscorable: 3,
        in_progress: 2,
        failed_students: 1,
        refused_students: 0,
      }),
    ).toEqual([
      "24 essays scored — 18 waiting for your review in the scoring queue, 6 finalized by AI (Hybrid).",
      "2 held back: they look like they try to instruct the AI. Read them in the scoring queue.",
      "1 not scored: the safety check didn't answer, so it was skipped. Run Score with AI again later.",
      "2 were already being scored from another press — check the scoring queue in a minute.",
      "1 stopped by the AI safety filter — score it by hand.",
      "1 couldn't be scored (the AI service didn't answer). Press the button again to retry.",
      "1 student's essays couldn't be sent. Press the button again to retry.",
      "3 have no rubric or are empty.",
    ]);
  });

  test("singular forms and the proposals-only line", () => {
    expect(
      scoreEssaysSummary({ ...EMPTY_TALLY, scored_proposed: 1, withheld: 1 }),
    ).toEqual([
      "1 essay scored — 1 waiting for your review in the scoring queue.",
      "1 held back: it looks like it tries to instruct the AI. Read it in the scoring queue.",
    ]);
  });

  test("an essay already being scored elsewhere; a route without the field", () => {
    expect(scoreEssaysSummary({ ...EMPTY_TALLY, in_progress: 1 })).toEqual([
      "1 was already being scored from another press — check the scoring queue in a minute.",
    ]);
    // Before the claim (#55) the route sends no in_progress: it reads as 0.
    expect(addToTally(EMPTY_TALLY, { ok: true, scored_proposed: 1 }).in_progress).toBe(0);
  });

  test("a refused request is not told to retry", () => {
    const t = addToTally(addToTally(EMPTY_TALLY, REFUSED), null);
    expect(t.refused_students).toBe(1);
    expect(t.failed_students).toBe(1);
    expect(scoreEssaysSummary({ ...EMPTY_TALLY, refused_students: 2 })).toEqual(
      [
        "2 students' essays couldn't be scored from this page. Reload it and check you can still edit this test.",
      ],
    );
  });

  test("which statuses are worth a retry", () => {
    expect(outcomeForStatus(201)).toBe("ok");
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(429)).toBe("retry");
    expect(outcomeForStatus(502)).toBe("retry");
    expect(outcomeForStatus(403)).toBe(REFUSED);
    expect(outcomeForStatus(404)).toBe(REFUSED);
    expect(outcomeForStatus(400)).toBe(REFUSED);
  });

  test("nothing to report", () => {
    expect(scoreEssaysSummary(EMPTY_TALLY)).toEqual([
      "Nothing was left to score.",
    ]);
  });
});

describe("runPool", () => {
  test("runs every id once, never more than the limit at a time", async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    await runPool(
      ids,
      3,
      async (id) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return id;
      },
      (id) => seen.push(id),
    );
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual(ids);
  });

  test("an empty list resolves at once", async () => {
    const seen: string[] = [];
    await runPool(
      [],
      3,
      async (id) => id,
      (id) => seen.push(id),
    );
    expect(seen).toEqual([]);
  });
});
