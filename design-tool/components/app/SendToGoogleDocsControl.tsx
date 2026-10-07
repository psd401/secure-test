"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  CONTENT_OPTIONS,
  DEFAULT_CONTENTS,
  authOutcomeCopy,
  authStartHref,
  outcomeReason,
  ownershipNote,
  parseSavedState,
  sendErrorCopy,
  stateToSave,
  storageKey,
  summaryLine,
  type DialogState,
  type SendOutcome,
} from "@/lib/googleDocs/sendDialog";

/**
 * "Send to Google Docs" (docs/google-docs-release-design.md, row GD slice 4).
 * Section mode on the results page (`sections`), one student on the
 * per-student page (`attemptId`). When the server answers
 * `drive_auth_needed`, the dialog's choices are saved to sessionStorage, the
 * teacher goes through Google, and the callback's `?gdrive=` reopens the
 * dialog here with those choices — the teacher presses Send once more.
 */
export function SendToGoogleDocsControl({
  assessmentId,
  sections,
  defaultSection,
  attemptId,
  studentName,
  returnPath,
}: {
  assessmentId: string;
  /** Section labels to choose from (results page). */
  sections?: string[];
  defaultSection?: string;
  /** One student (per-student page). */
  attemptId?: string;
  studentName?: string;
  /** This page's path + query; the authorization run returns here. */
  returnPath: string;
}) {
  const single = attemptId ?? null;
  const key = storageKey(assessmentId, single);
  const initialSection =
    defaultSection && sections?.includes(defaultSection) ? defaultSection : (sections?.[0] ?? "");

  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DialogState>({
    section: initialSection,
    contents: DEFAULT_CONTENTS,
    mode: "skip",
    includeDrafts: false,
    transferOwnership: false,
    doubleSpace: false,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<SendOutcome[] | null>(null);

  // Back from Google: reopen with the saved choices, then drop `?gdrive=`.
  useEffect(() => {
    const url = new URL(window.location.href);
    const gdrive = url.searchParams.get("gdrive");
    if (!gdrive) return;
    let saved: DialogState | null = null;
    try {
      saved = parseSavedState(window.sessionStorage.getItem(key));
      window.sessionStorage.removeItem(key);
    } catch {
      saved = null;
    }
    if (!saved) return;
    url.searchParams.delete("gdrive");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setState(saved);
    setNotice(authOutcomeCopy(gdrive));
    setOpen(true);
  }, [key]);

  function openDialog() {
    setOutcomes(null);
    setError(null);
    setNotice(null);
    setOpen(true);
  }

  function close() {
    if (busy) return;
    setOpen(false);
    if (outcomes?.some((o) => o.status === "sent")) window.location.reload();
  }

  function goAuthorize(current: SendOutcome[] | null) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(stateToSave(state, current)));
    } catch {
      // Private window / blocked storage: the teacher re-picks after Google.
    }
    window.location.assign(authStartHref(returnPath));
  }

  async function send() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/google-docs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(single ? { attempt_id: single } : { section: state.section }),
          contents: state.contents,
          mode: state.mode,
          include_drafts: state.includeDrafts,
          transfer_ownership: state.transferOwnership,
          double_space: state.doubleSpace,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        outcomes?: SendOutcome[];
        drive_auth_needed?: boolean;
      };
      if (res.status === 401 && body.error === "drive_auth_needed") {
        goAuthorize(null);
        return;
      }
      if (!res.ok || !body.ok) {
        setError(sendErrorCopy(body.error ?? `http_${res.status}`));
        return;
      }
      setOutcomes(body.outcomes ?? []);
      if (body.drive_auth_needed) {
        setNotice({
          ok: false,
          text: "Google access expired partway through. Reconnect, then Send again — students who already have a Doc are skipped.",
        });
      }
    } catch {
      setError(sendErrorCopy("network"));
    } finally {
      setBusy(false);
    }
  }

  const authLost = notice?.ok === false && outcomes !== null;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Send to Google Docs
      </button>
      <Dialog open={open} onOpenChange={(o) => (!o ? close() : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send to Google Docs</DialogTitle>
            <DialogDescription>
              {single
                ? `Makes a Google Doc of ${studentName ?? "this student"}'s essays in your Drive and shares it with them to edit.`
                : "Makes a Google Doc of each student's essays in your Drive and shares it with them to edit."}{" "}
              Changes in the Doc do not come back here.
            </DialogDescription>
          </DialogHeader>

          {notice ? (
            <p
              role={notice.ok ? "status" : "alert"}
              className={notice.ok ? "text-sm" : "text-sm text-danger-foreground"}
            >
              {notice.text}
            </p>
          ) : null}

          {outcomes ? (
            <div className="space-y-2 text-sm" aria-live="polite">
              <p className="font-medium">{summaryLine(outcomes)}</p>
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {outcomes.map((o) => (
                  <li key={o.attempt_id}>
                    {o.status === "sent" && o.url ? (
                      <a href={o.url} target="_blank" rel="noreferrer" className="underline">
                        {o.name}
                      </a>
                    ) : (
                      <span>{o.name}</span>
                    )}
                    {o.status === "sent" && ownershipNote(o) ? (
                      <span
                        className={
                          o.ownership === "not_transferred"
                            ? "text-danger-foreground"
                            : "text-muted-foreground"
                        }
                      >
                        {" "}
                        — {ownershipNote(o)}
                      </span>
                    ) : null}
                    {o.status === "sent" ? null : (
                      <span
                        className={
                          o.status === "failed" ? "text-danger-foreground" : "text-muted-foreground"
                        }
                      >
                        {" "}
                        — {outcomeReason(o)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {single ? null : (
                <label className="block">
                  <span className="block text-xs text-muted-foreground">Section</span>
                  <NativeSelect
                    value={state.section}
                    disabled={busy}
                    onChange={(e) => setState({ ...state, section: e.target.value })}
                    aria-label="Section"
                    className="w-full"
                  >
                    {(sections ?? []).map((s) => (
                      <NativeSelectOption key={s} value={s}>
                        {s}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              )}

              <fieldset>
                <legend className="text-xs text-muted-foreground">
                  In the Doc (the essay is always included)
                </legend>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  {CONTENT_OPTIONS.map(({ key: k, label }) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={state.contents[k]}
                        disabled={busy}
                        onChange={(e) =>
                          setState({ ...state, contents: { ...state.contents, [k]: e.target.checked } })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Score and feedback come from final scores only. With Prompt or Sources, students can
                  copy them out of the Doc.
                </p>
              </fieldset>

              <fieldset>
                <legend className="text-xs text-muted-foreground">
                  {single ? "If this student already has a Doc from you" : "Students who already have a Doc from you"}
                </legend>
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="radio"
                    name="gd-mode"
                    checked={state.mode === "skip"}
                    disabled={busy}
                    onChange={() => setState({ ...state, mode: "skip" })}
                  />
                  Skip them
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="gd-mode"
                    checked={state.mode === "new"}
                    disabled={busy}
                    onChange={() => setState({ ...state, mode: "new" })}
                  />
                  Make a new Doc (dated today)
                </label>
              </fieldset>

              {/* RT D-10 (docs/rich-text-essay-design.md): a teacher-side
                  choice, default off. The Doc's essay paragraphs carry line
                  spacing 2.0, so it stays double-spaced as the student edits. */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.doubleSpace}
                  disabled={busy}
                  onChange={(e) => setState({ ...state, doubleSpace: e.target.checked })}
                />
                Double-space essays
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.includeDrafts}
                  disabled={busy}
                  onChange={(e) => setState({ ...state, includeDrafts: e.target.checked })}
                />
                {single ? "Send even if not handed in yet" : "Include students who have not handed in"}
              </label>

              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={state.transferOwnership}
                  disabled={busy}
                  onChange={(e) => setState({ ...state, transferOwnership: e.target.checked })}
                />
                <span>
                  {single ? "Give the student ownership of the Doc" : "Give students ownership of their Doc"}
                  <span className="block text-xs text-muted-foreground">
                    The Doc becomes theirs. You keep edit access, and it stays listed in your folder.
                  </span>
                </span>
              </label>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {outcomes ? (
              <>
                {authLost ? (
                  <Button type="button" variant="outline" onClick={() => goAuthorize(outcomes)}>
                    Reconnect Google Drive
                  </Button>
                ) : null}
                <Button type="button" onClick={close}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy || (!single && !state.section)}
                >
                  {busy ? "Sending…" : "Send"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
