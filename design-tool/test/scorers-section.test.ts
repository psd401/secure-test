// Competency assessments, slice 5b (docs/competency-assessment-design.md):
// the Scorers section turns the picked day into the grant's `ends_at`. The
// rule worth pinning: "Scoring through Friday" keeps access all of Friday.
import { describe, expect, test } from "bun:test";
import { scoringEndsAt } from "../components/app/ScorersSection";

describe("scoringEndsAt", () => {
  test("the end of the picked day, in the browser's time zone", () => {
    const iso = scoringEndsAt("2026-12-18");
    expect(iso).not.toBeNull();
    const end = new Date(iso!);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(11);
    expect(end.getDate()).toBe(18);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
  });

  test("empty or malformed input gives no date", () => {
    expect(scoringEndsAt("")).toBeNull();
    expect(scoringEndsAt("12/18/2026")).toBeNull();
    expect(scoringEndsAt("2026-13-45")).toBeNull();
  });
});
