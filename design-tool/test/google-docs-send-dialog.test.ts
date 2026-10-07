// Row GD slice 4 (docs/google-docs-release-design.md): the "Send to Google
// Docs" dialog's pure logic. The component itself is a hand-run row — the
// repo has no DOM harness.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONTENTS,
  authOutcomeCopy,
  authStartHref,
  canSendToGoogleDocs,
  outcomeReason,
  ownershipNote,
  parseSavedState,
  stateToSave,
  storageKey,
  summaryLine,
  type DialogState,
  type SendOutcome,
} from "../lib/googleDocs/sendDialog";

const STATE: DialogState = {
  section: "English 10 · 2(A)",
  contents: { ...DEFAULT_CONTENTS, prompt: true },
  mode: "new",
  includeDrafts: true,
  transferOwnership: true,
  doubleSpace: true,
};

const o = (status: SendOutcome["status"], reason?: string): SendOutcome => ({
  attempt_id: `${status}-${reason ?? ""}`,
  name: "S",
  status,
  reason,
});

describe("send dialog logic", () => {
  test("the button shows at edit level, not acting as, with an essay", () => {
    const base = { editLevel: true, actingAs: false, itemTypes: ["multiple_choice_single", "essay"] };
    expect(canSendToGoogleDocs(base)).toBe(true);
    expect(canSendToGoogleDocs({ ...base, editLevel: false })).toBe(false);
    expect(canSendToGoogleDocs({ ...base, actingAs: true })).toBe(false);
    expect(canSendToGoogleDocs({ ...base, itemTypes: ["short_text"] })).toBe(false);
  });

  test("the summary counts each status", () => {
    expect(summaryLine([o("sent"), o("sent"), o("skipped", "no_essay"), o("failed", "x")])).toBe(
      "2 Docs created and shared · 1 skipped · 1 failed.",
    );
    expect(summaryLine([o("sent")])).toBe("1 Doc created and shared.");
    expect(summaryLine([])).toBe("No students in this section have work here yet.");
  });

  test("every reason reads as words; a Drive refusal names its code", () => {
    expect(outcomeReason(o("skipped", "safeguarding_alert"))).toContain("safeguarding alert");
    expect(outcomeReason(o("skipped", "already_released"))).toBe("already has a Doc from you");
    expect(outcomeReason(o("failed", "storageQuotaExceeded"))).toBe(
      "Google Drive refused (storageQuotaExceeded)",
    );
  });

  test("ownership notes", () => {
    expect(ownershipNote({ ...o("sent"), ownership: "transferred" })).toBe("owned by the student");
    expect(ownershipNote({ ...o("sent"), ownership: "not_transferred", ownership_error: "x" })).toBe(
      "shared, but ownership not transferred (x)",
    );
    expect(ownershipNote(o("sent"))).toBeNull();
  });

  test("auth outcomes: only ok is ok", () => {
    expect(authOutcomeCopy("ok").ok).toBe(true);
    for (const x of ["denied", "wrong_account", "scope_mismatch", "expired", "anything"]) {
      expect(authOutcomeCopy(x).ok).toBe(false);
    }
  });

  test("saved state round-trips, and a partial send comes back as skip", () => {
    expect(parseSavedState(JSON.stringify(STATE))).toEqual(STATE);
    expect(stateToSave(STATE, null).mode).toBe("new");
    expect(stateToSave(STATE, [o("sent"), o("skipped", "drive_auth_expired")]).mode).toBe("skip");
    expect(parseSavedState("not json")).toBeNull();
    const { transferOwnership: _omit, ...older } = STATE;
    expect(parseSavedState(JSON.stringify(older))!.transferOwnership).toBe(false);
    // RT D-10: a state saved before the double-space box reads as off.
    const { doubleSpace: _omit2, ...beforeRt } = STATE;
    expect(parseSavedState(JSON.stringify(beforeRt))!.doubleSpace).toBe(false);
    expect(parseSavedState(JSON.stringify({ ...STATE, doubleSpace: "yes" }))!.doubleSpace).toBe(false);
    expect(parseSavedState(JSON.stringify({ ...STATE, mode: "everything" }))).toBeNull();
    expect(parseSavedState(JSON.stringify({ ...STATE, contents: { prompt: "yes" } }))!.contents).toEqual(
      DEFAULT_CONTENTS,
    );
  });

  test("keys and the authorization link", () => {
    expect(storageKey("a1", null)).toBe("gd-send:a1:section");
    expect(storageKey("a1", "t1")).toBe("gd-send:a1:t1");
    expect(authStartHref("/dashboard/a1/results?section=P 2")).toBe(
      "/api/google/drive/start?next=%2Fdashboard%2Fa1%2Fresults%3Fsection%3DP%202",
    );
  });
});
