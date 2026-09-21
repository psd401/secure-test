// System admin "All teachers" view, access slice 5a
// (docs/access-model-design.md, D-6 clarified 2026-09-21).
//
// Same posture as test/co-teach-ui.test.tsx: no DOM harness exists here, so
// the home page's server component exports its gating logic as pure
// functions and this file checks those directly rather than markup.
import { describe, expect, test } from "bun:test";
import {
  dashboardHref,
  homeListMode,
  showAllTeachersToggle,
} from "../app/dashboard/page";

describe("showAllTeachersToggle", () => {
  test("true only for a session isAdmin recognises", () => {
    const originalAdminEmails = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "sysadmin@psd401.net";
    try {
      expect(showAllTeachersToggle({ email: "sysadmin@psd401.net" })).toBe(true);
      expect(showAllTeachersToggle({ email: "teacher@psd401.net" })).toBe(false);
      expect(showAllTeachersToggle({ email: undefined })).toBe(false);
    } finally {
      if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdminEmails;
    }
  });
});

describe("homeListMode", () => {
  test("a non-admin is always mine, even with ?all=1 typed by hand", () => {
    expect(homeListMode({ all: "1" }, false)).toBe("mine");
    expect(homeListMode({}, false)).toBe("mine");
  });

  test("an admin is mine by default and all only on ?all=1", () => {
    expect(homeListMode({}, true)).toBe("mine");
    expect(homeListMode({ all: "0" }, true)).toBe("mine");
    expect(homeListMode({ all: "1" }, true)).toBe("all");
  });
});

describe("dashboardHref", () => {
  test("no params set — the bare path", () => {
    expect(dashboardHref({ archived: false, all: false })).toBe("/dashboard");
  });

  test("composes archived and all independently", () => {
    expect(dashboardHref({ archived: true, all: false })).toBe("/dashboard?archived=1");
    expect(dashboardHref({ archived: false, all: true })).toBe("/dashboard?all=1");
    expect(dashboardHref({ archived: true, all: true })).toBe("/dashboard?archived=1&all=1");
  });
});
