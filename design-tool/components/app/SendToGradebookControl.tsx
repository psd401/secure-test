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
import type { SendSummary } from "@/lib/gradebook/types";
import {
  ASSIGNMENT_NAME_MAX,
  SEND_TARGET,
  canSubmitSend,
  chooseCategory,
  defaultAssignmentName,
  formatFailure,
  formatSendSummary,
  sectionOptionLabel,
  sendAgainNote,
  sendButtonLabel,
  sendErrorCopy,
  todayLocal,
  type CategoryOption,
  type SendDialogSection,
} from "@/lib/gradebook/sendDialog";

class SendError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code);
  }
}

async function readError(res: Response): Promise<SendError> {
  let code = `http_${res.status}`;
  let detail: unknown;
  try {
    const body = (await res.json()) as { error?: unknown; detail?: unknown };
    if (typeof body.error === "string") code = body.error;
    detail = body.detail;
  } catch {
    // not JSON
  }
  return new SendError(code, detail);
}

function describe(e: unknown): string {
  if (e instanceof SendError) return sendErrorCopy(e.code, e.detail);
  return sendErrorCopy("network");
}

interface CategoriesResponse {
  categories: CategoryOption[];
  default_category_id: string | null;
  remembered: { target: string; category_id: string | null } | null;
}

/**
 * "Send to gradebook" (docs/gradebook-push-design.md, slice 4): the results
 * page's button + dialog. PowerSchool only — the destination is `SEND_TARGET`;
 * a destination picker (slice 3) would be added at the marked spot below.
 *
 * The caller (a server component) passes only the sections this teacher can
 * send and only renders the control at edit level.
 */
export function SendToGradebookControl({
  assessmentId,
  assessmentName,
  sections,
  onDone,
}: {
  assessmentId: string;
  assessmentName: string;
  sections: SendDialogSection[];
  /** After the summary is dismissed following a send (the page reloads). */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sectionPsId, setSectionPsId] = useState<string>(sections[0]?.ps_id ?? "");
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(defaultAssignmentName(assessmentName));
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SendSummary | null>(null);

  const section = sections.find((s) => s.ps_id === sectionPsId) ?? null;
  const lastSent = sections.reduce<string | null>(
    (latest, s) => (s.last_sent_at && (!latest || s.last_sent_at > latest) ? s.last_sent_at : latest),
    null,
  );

  // Load the categories for the chosen section while the dialog is open.
  useEffect(() => {
    if (!open || !sectionPsId || summary) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCategories([]);
    setCategoryId(null);
    (async () => {
      try {
        const qs = new URLSearchParams({ target: SEND_TARGET, section_ps_id: sectionPsId });
        const res = await fetch(`/api/assessments/${assessmentId}/gradebook-categories?${qs}`);
        if (!res.ok) throw await readError(res);
        const body = (await res.json()) as CategoriesResponse;
        if (cancelled) return;
        setCategories(body.categories);
        setCategoryId(
          chooseCategory(body.categories, body.default_category_id, body.remembered?.category_id ?? null)
            .selected,
        );
      } catch (err) {
        if (!cancelled) setError(describe(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sectionPsId, assessmentId, summary]);

  function openDialog() {
    setSummary(null);
    setError(null);
    setName(defaultAssignmentName(assessmentName));
    setDueDate(todayLocal()); // 8.1
    setSectionPsId((cur) => (sections.some((s) => s.ps_id === cur) ? cur : (sections[0]?.ps_id ?? "")));
    setOpen(true);
  }

  function close() {
    if (busy) return;
    setOpen(false);
    if (summary) onDone();
  }

  async function send() {
    if (!categoryId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/gradebook-send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: SEND_TARGET,
          section_ps_id: sectionPsId,
          category_id: categoryId,
          name: name.trim(),
          due_date: dueDate,
        }),
      });
      if (!res.ok) throw await readError(res);
      setSummary((await res.json()) as SendSummary);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  const mustPick = !loading && categories.length > 0 && !categoryId;
  const note = sendAgainNote(section?.last_sent_at ?? null);

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      >
        {sendButtonLabel(lastSent)}
        {lastSent ? <span className="ml-2 text-xs text-muted-foreground">Send again</span> : null}
      </button>
      <Dialog open={open} onOpenChange={(o) => (!o ? close() : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send to gradebook</DialogTitle>
            <DialogDescription>
              Writes each fully scored student&rsquo;s points to PowerSchool. Work still awaiting
              scoring is held back, never sent as a partial score.
            </DialogDescription>
          </DialogHeader>

          {summary ? (
            <div className="space-y-2 text-sm" aria-live="polite">
              {formatSendSummary(summary).map((line, i) => (
                <p key={i} className={i === 0 ? "font-medium" : "text-muted-foreground"}>
                  {line}
                </p>
              ))}
              {summary.failed.length > 0 ? (
                <div>
                  <p className="font-medium text-danger-foreground">These were not sent:</p>
                  <ul className="mt-1 list-disc pl-5 text-danger-foreground">
                    {summary.failed.map((f, i) => (
                      <li key={i}>{formatFailure(f)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {/* Destination picker goes here when Schoology (slice 3) lands. */}
              <label className="block">
                <span className="block text-xs text-muted-foreground">Section</span>
                <NativeSelect
                  value={sectionPsId}
                  disabled={busy}
                  onChange={(e) => setSectionPsId(e.target.value)}
                  aria-label="Section"
                  className="w-full"
                >
                  {sections.map((s) => (
                    <NativeSelectOption key={s.ps_id} value={s.ps_id}>
                      {sectionOptionLabel(s)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}

              <label className="block">
                <span className="block text-xs text-muted-foreground">Category</span>
                <NativeSelect
                  value={categoryId ?? ""}
                  disabled={busy || loading || categories.length === 0}
                  onChange={(e) => setCategoryId(e.target.value || null)}
                  aria-label="Category"
                  className="w-full"
                >
                  <NativeSelectOption value="">
                    {loading ? "Loading categories…" : "Pick a category"}
                  </NativeSelectOption>
                  {categories.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {mustPick ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    No default category is active for you in this section — pick one.
                  </span>
                ) : null}
              </label>

              <label className="block">
                <span className="block text-xs text-muted-foreground">Assignment name</span>
                <input
                  type="text"
                  value={name}
                  maxLength={ASSIGNMENT_NAME_MAX}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Assignment name"
                  className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
              </label>

              <label className="block">
                <span className="block text-xs text-muted-foreground">Due date</span>
                <input
                  type="date"
                  value={dueDate}
                  disabled={busy}
                  onChange={(e) => setDueDate(e.target.value)}
                  aria-label="Due date"
                  className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
              </label>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {summary ? (
              <Button type="button" onClick={close}>
                Done
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSubmitSend({ loading, busy, sectionPsId, categoryId, name, dueDate })}
                >
                  {busy ? "Sending…" : lastSent && section?.last_sent_at ? "Send again" : "Send"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
