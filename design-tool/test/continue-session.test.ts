// Row ES (docs/ended-session-rejoin-design.md): the pure half of "Continue in
// a new session" — when it is offered and the body it posts.
import { describe, expect, test } from "bun:test";
import {
  canContinueInNewSession,
  continueSessionBody,
  endedSessionBanner,
} from "../app/dashboard/[id]/attendanceView";
import { continuedMonitorHref } from "../components/app/ContinueInNewSessionControl";

const NOW = Date.parse("2026-10-19T16:00:00Z");
const PAST = "2026-10-16T16:22:00Z";
const FUTURE = "2026-10-19T17:00:00Z";

describe("canContinueInNewSession", () => {
  test("an open sitting past its end time is offered", () => {
    expect(canContinueInNewSession({ status: "open", expires_at: PAST, kind: "class" }, NOW)).toBe(true);
  });
  test("a closed sitting is offered, even before its end time", () => {
    expect(canContinueInNewSession({ status: "closed", expires_at: FUTURE, kind: "class" }, NOW)).toBe(true);
  });
  test("a live sitting is not", () => {
    expect(canContinueInNewSession({ status: "open", expires_at: FUTURE, kind: "class" }, NOW)).toBe(false);
  });
  test("a practice sitting never is", () => {
    expect(canContinueInNewSession({ status: "closed", expires_at: PAST, kind: "practice" }, NOW)).toBe(false);
  });
  test("an older row without kind counts as a class sitting", () => {
    expect(canContinueInNewSession({ status: "closed", expires_at: PAST }, NOW)).toBe(true);
  });
});

describe("continueSessionBody", () => {
  test("copies one section", () => {
    expect(continueSessionBody("a1", { section_ps_id: "S1", student_ps_ids: null }, 55)).toEqual({
      assessment_id: "a1",
      duration_minutes: 55,
      section_ps_id: "S1",
    });
  });
  test("copies a student list", () => {
    expect(continueSessionBody("a1", { section_ps_id: null, student_ps_ids: ["1", "2"] }, 30)).toEqual({
      assessment_id: "a1",
      duration_minutes: 30,
      student_ps_ids: ["1", "2"],
    });
  });
  test("no scope = all sections", () => {
    expect(continueSessionBody("a1", { section_ps_id: null, student_ps_ids: null }, 55)).toEqual({
      assessment_id: "a1",
      duration_minutes: 55,
    });
  });
});

describe("endedSessionBanner", () => {
  test("nothing when no one is mid-test", () => {
    expect(endedSessionBanner(0)).toBeNull();
  });
  test("names the count and says Adjust time alone won't do it", () => {
    expect(endedSessionBanner(1)).toContain("1 student hasn't handed in");
    const five = endedSessionBanner(5) ?? "";
    expect(five).toContain("5 students haven't handed in");
    expect(five).toContain("Adjust time alone doesn't let anyone back in");
  });
});

describe("continuedMonitorHref", () => {
  test("opens the new sitting's Monitor on its code", () => {
    expect(continuedMonitorHref("a1", "s2")).toBe("/dashboard/a1/monitor/s2?code=1");
  });
});
