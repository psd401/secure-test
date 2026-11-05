// Competency assessments, slice 5b (docs/competency-assessment-design.md):
// the Scorers section turns the picked day into the grant's `ends_at`. The
// rule worth pinning: "Scoring through Friday" keeps access all of Friday.
import { describe, expect, test } from "bun:test";
import { scoringEndsAt } from "../components/app/ScorersSection";

describe("scoringEndsAt", () => {
  test("the end of the picked day, in the district's time zone", () => {
    // 23:59:59 PST on Dec 18 is 07:59:59 UTC on Dec 19, whatever the device's zone.
    expect(scoringEndsAt("2026-12-18")).toBe("2026-12-19T07:59:59.000Z");
  });

  test("empty or malformed input gives no date", () => {
    expect(scoringEndsAt("")).toBeNull();
    expect(scoringEndsAt("12/18/2026")).toBeNull();
    expect(scoringEndsAt("2026-13-45")).toBeNull();
  });
});
