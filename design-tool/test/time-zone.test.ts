/**
 * lib/timeZone: typed-in times are read in the district's zone, not the
 * device's. Run under any TZ — the CI and a teacher's travelling laptop
 * differ — so every expectation here is an absolute instant.
 * `bun test` with `TZ=Asia/Tokyo` or `TZ=UTC` must give the same results.
 */
import { describe, expect, test } from "bun:test";
import { addDays, DISPLAY_TIME_ZONE, todayInZone, zonedWallTimeToIso } from "../lib/timeZone";
import { defaultExtendValue, toIsoInstant } from "../components/app/ExtendTimeControl";
import { scoringEndsAt } from "../components/app/ScorersSection";
import { todayLocal } from "../lib/gradebook/sendDialog";

describe("DISPLAY_TIME_ZONE", () => {
  test("is the district's", () => {
    expect(DISPLAY_TIME_ZONE).toBe("America/Los_Angeles");
  });
});

describe("zonedWallTimeToIso", () => {
  test("summer (PDT, UTC−7)", () => {
    expect(zonedWallTimeToIso("2026-09-18T14:30")).toBe("2026-09-18T21:30:00.000Z");
  });

  test("winter (PST, UTC−8)", () => {
    expect(zonedWallTimeToIso("2026-12-01T14:30")).toBe("2026-12-01T22:30:00.000Z");
  });

  test("seconds are kept; end of day crosses into the next UTC day", () => {
    expect(zonedWallTimeToIso("2026-09-18T23:59:59")).toBe("2026-09-19T06:59:59.000Z");
  });

  test("the day DST ends: 23:59 is already PST", () => {
    // 2026-11-01, clocks fall back at 02:00 PDT.
    expect(zonedWallTimeToIso("2026-11-01T23:59")).toBe("2026-11-02T07:59:00.000Z");
  });

  test("the day DST starts: an hour that does not exist lands an hour later", () => {
    // 2026-03-08, 02:00 PST jumps to 03:00 PDT; 02:30 is 03:30 PDT.
    expect(zonedWallTimeToIso("2026-03-08T02:30")).toBe("2026-03-08T10:30:00.000Z");
  });

  test("the fall-back hour happens twice: the earlier (PDT) one", () => {
    // 2026-11-01 01:30 occurs at 08:30Z (PDT) and again at 09:30Z (PST).
    expect(zonedWallTimeToIso("2026-11-01T01:30")).toBe("2026-11-01T08:30:00.000Z");
  });

  test("a day the month does not have: null, not rolled forward", () => {
    expect(zonedWallTimeToIso("2026-02-31T12:00")).toBeNull();
    expect(zonedWallTimeToIso("2026-04-31T23:59:59")).toBeNull();
    expect(zonedWallTimeToIso("2026-02-29T12:00")).toBeNull(); // not a leap year
    expect(zonedWallTimeToIso("2028-02-29T12:00")).toBe("2028-02-29T20:00:00.000Z");
  });

  test("empty or malformed: null", () => {
    expect(zonedWallTimeToIso("")).toBeNull();
    expect(zonedWallTimeToIso("2026-09-18")).toBeNull();
    expect(zonedWallTimeToIso("2026-13-01T10:00")).toBeNull();
    expect(zonedWallTimeToIso("2026-09-18T24:00")).toBeNull();
    expect(zonedWallTimeToIso("not a date")).toBeNull();
  });
});

describe("todayInZone / addDays", () => {
  test("the district's date, not UTC's", () => {
    // 05:00 UTC on Sep 18 is still 22:00 on Sep 17 in Pacific.
    expect(todayInZone(new Date("2026-09-18T05:00:00Z"))).toBe("2026-09-17");
    expect(todayInZone(new Date("2026-09-18T08:00:00Z"))).toBe("2026-09-18");
  });

  test("addDays crosses months and years", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("the pickers read in the district's zone", () => {
  test("toIsoInstant: 2:30 PM typed is 2:30 PM Pacific", () => {
    expect(toIsoInstant("2026-09-18T14:30")).toBe("2026-09-18T21:30:00.000Z");
  });

  test("defaultExtendValue: today in Pacific, even when UTC has moved on", () => {
    // 05:00 UTC Sep 18 = 22:00 PDT Sep 17.
    expect(defaultExtendValue(new Date("2026-09-18T05:00:00Z"))).toBe("2026-09-17T23:59");
  });

  test("defaultExtendValue: in Pacific's last minute of the day, tomorrow", () => {
    // 23:59:20 PDT Sep 30 = 06:59:20 UTC Oct 1.
    expect(defaultExtendValue(new Date("2026-10-01T06:59:20Z"))).toBe("2026-10-01T23:59");
  });

  test("defaultExtendValue: on the day DST ends, today is still today", () => {
    // 22:00 PST on 2026-11-01 (06:00Z Nov 2); 23:59 that night is still ahead.
    expect(defaultExtendValue(new Date("2026-11-02T06:00:00Z"))).toBe("2026-11-01T23:59");
  });

  test("defaultExtendValue: on the day DST starts, likewise", () => {
    // 22:00 PDT on 2026-03-08 (05:00Z Mar 9).
    expect(defaultExtendValue(new Date("2026-03-09T05:00:00Z"))).toBe("2026-03-08T23:59");
  });

  test("scoringEndsAt: an impossible day is refused, not shifted", () => {
    expect(scoringEndsAt("2026-02-31")).toBeNull();
  });

  test("scoringEndsAt: end of the chosen day in Pacific", () => {
    expect(scoringEndsAt("2026-09-18")).toBe("2026-09-19T06:59:59.000Z");
  });

  test("todayLocal (gradebook due date): the district's date", () => {
    expect(todayLocal(new Date("2026-09-06T05:00:00Z"))).toBe("2026-09-05");
  });
});
