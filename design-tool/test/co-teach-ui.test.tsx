// Co-teach UI, access slice 3 (docs/access-model-design.md, D-4 (b)).
//
// No testing-library / DOM harness exists in this repo (test/error-boundaries.test.tsx),
// and `<ShareDialog>`'s Radix `Dialog` renders nothing through
// `renderToStaticMarkup` while `open` — its `Portal` needs a real `document`
// (confirmed: the same render used below for a CLOSED dialog produces empty
// markup for an open one too). So this file checks the pure logic the editor
// and the dialog gate on, the way test/extend-time-control.test.tsx and
// test/hand-in-all-control.test.tsx check theirs — not markup.
import { describe, expect, test } from "bun:test";
import {
  coTeachingBadgeText,
  isOwnerAccess,
} from "../app/dashboard/[id]/AssessmentEditor";
import { sectionLabel } from "../components/app/ShareDialog";
import { coTeachErrorCopy } from "../lib/ui/errorCopy";

describe("isOwnerAccess", () => {
  test("true only for via: owner", () => {
    expect(isOwnerAccess({ via: "owner" })).toBe(true);
    expect(isOwnerAccess({ via: "grant" })).toBe(false);
    expect(isOwnerAccess({ via: "admin" })).toBe(false);
  });
});

describe("coTeachingBadgeText", () => {
  test("null for the owner and for an admin — no reminder needed", () => {
    expect(coTeachingBadgeText({ via: "owner", owner_email: null })).toBeNull();
    expect(coTeachingBadgeText({ via: "admin", owner_email: null })).toBeNull();
  });

  test("names the owner for a co-teacher (via: grant)", () => {
    expect(coTeachingBadgeText({ via: "grant", owner_email: "lead@psd401.net" })).toBe(
      "Co-teaching (owner: lead@psd401.net)",
    );
  });

  test("falls back to the bare label when owner_email is unresolved (migration 0038 deviation)", () => {
    expect(coTeachingBadgeText({ via: "grant", owner_email: null })).toBe("Co-teaching");
  });
});

describe("sectionLabel", () => {
  test("course and period, joined", () => {
    expect(sectionLabel({ course_name: "Algebra 1", period_expression: "3(A)" })).toBe(
      "Algebra 1 · 3(A)",
    );
  });

  test("falls back to the bare course name with no period", () => {
    expect(sectionLabel({ course_name: "Algebra 1", period_expression: "" })).toBe("Algebra 1");
  });
});

describe("coTeachErrorCopy", () => {
  test("already_granted", () => {
    expect(coTeachErrorCopy("already_granted").message).toBe("Already a co-teacher.");
  });

  test("a non-staff or malformed address", () => {
    expect(coTeachErrorCopy("grantee_not_staff").message).toBe(
      "Enter a psd401.net staff address.",
    );
    expect(coTeachErrorCopy("invalid_email").message).toBe("Enter a psd401.net staff address.");
  });

  test("self_grant", () => {
    expect(coTeachErrorCopy("self_grant").message).toBe("That's you.");
  });

  test("an unknown code falls back to the generic message and shows the code", () => {
    const copy = coTeachErrorCopy("something_new");
    expect(copy.message).toContain("tell IT this code");
    expect(copy.showCode).toBe(true);
  });
});
