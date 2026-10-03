"use client";

import { useEffect, useId, useState } from "react";
import { Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { loadFacets, readPrefs, writePrefs } from "@/components/app/StandardsTagInput";
import {
  SUGGEST_MAX_UNIT_LIST,
  SUGGEST_SUBJECTS,
  SUGGEST_SUBJECT_LABEL,
  buildSuggestFetchInit,
  describeSuggestError,
  emptySuggestForm,
  fetchSuggestionEntries,
  gradeBandLabel,
  needsCourse,
  suggestionMapFrom,
  suggestionSummary,
  validateSuggestForm,
  type SuggestEntry,
  type SuggestFormValues,
  type SuggestResponse,
  type SuggestSubject,
  type SuggestionMap,
} from "@/lib/ai/suggestForm";

// BG slice 5 (docs/batch-item-generation-design.md D-2): "Suggest standards"
// on the Items tab. The form posts to POST /api/ai/suggest-standards, which
// WRITES NOTHING; the answer goes up to the editor as chips on each untagged
// question's card (page state only, 1.1) and the dialog closes. The editor
// owns Accept / Dismiss — an accepted tag is saved through the ordinary item
// save, so nothing records that it was suggested (D-2a).

type Facets = { grade_bands: Record<SuggestSubject, string[]>; courses: string[] };

export interface SuggestOutcome {
  map: SuggestionMap;
  entries: Record<string, SuggestEntry>;
  summary: string;
}

export function SuggestStandardsDialog({
  assessmentId,
  disabled,
  onSuggested,
}: {
  assessmentId: string;
  disabled?: boolean;
  onSuggested: (outcome: SuggestOutcome) => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<SuggestFormValues>(() => emptySuggestForm());
  const [prefilled, setPrefilled] = useState(false);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validateSuggestForm(values);
  const canSubmit = Object.keys(errors).length === 0;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadFacets().then((f) => {
      if (!cancelled) setFacets(f);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (busy) return; // never close mid-request
    if (next && !prefilled) {
      // The picker's remembered subject / grade / course / scheme, once.
      const p = readPrefs();
      setValues((v) => ({
        ...v,
        subject: p.subject,
        gradeBand: p.gradeBand,
        course: p.course,
        scheme: p.prefer,
      }));
      setPrefilled(true);
    }
    setOpen(next);
  }

  function patch(p: Partial<SuggestFormValues>) {
    setValues((v) => ({ ...v, ...p }));
  }

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/suggest-standards", buildSuggestFetchInit(assessmentId, values));
      const body = (await res.json().catch(() => null)) as
        | (Partial<SuggestResponse> & { ok?: boolean; error?: string; detail?: string; note?: string })
        | null;
      if (!res.ok || !body?.ok || !body.suggestions) {
        setError(describeSuggestError(res.status, body));
        return;
      }
      const result: SuggestResponse = {
        suggestions: body.suggestions,
        considered: body.considered ?? 0,
        left_out: body.left_out ?? 0,
      };
      const map = suggestionMapFrom(result);
      const entries = await fetchSuggestionEntries(Object.values(map).flatMap((t) => t.map((x) => x.tag)));
      // Remember the filter for every standards picker on the page.
      writePrefs({
        ...readPrefs(),
        subject: values.subject as SuggestSubject,
        gradeBand: values.gradeBand,
        course: needsCourse(values) ? values.course : "",
        prefer: values.scheme,
      });
      onSuggested({ map, entries, summary: suggestionSummary(result) });
      setOpen(false);
    } catch {
      setError(describeSuggestError(0, null));
    } finally {
      setBusy(false);
    }
  }

  const bands = values.subject && facets ? (facets.grade_bands[values.subject] ?? []) : [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Tags aria-hidden />
          Suggest standards
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggest standards</DialogTitle>
          <DialogDescription>
            The AI suggests up to three standards for each question that has none. Nothing is
            applied until you accept it.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          aria-busy={busy}
        >
          <fieldset disabled={busy} className="space-y-4 border-0 p-0">
            <div className="flex flex-wrap items-start gap-3">
              <div className="space-y-1">
                <label htmlFor={`${uid}-subject`} className="block text-sm font-medium">
                  Subject
                </label>
                <NativeSelect
                  id={`${uid}-subject`}
                  size="sm"
                  value={values.subject}
                  aria-invalid={errors.subject ? true : undefined}
                  onChange={(e) =>
                    patch({ subject: e.target.value as SuggestFormValues["subject"], gradeBand: "", course: "" })
                  }
                >
                  <NativeSelectOption value="">Choose…</NativeSelectOption>
                  {SUGGEST_SUBJECTS.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {SUGGEST_SUBJECT_LABEL[s]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-grade`} className="block text-sm font-medium">
                  Grade
                </label>
                <NativeSelect
                  id={`${uid}-grade`}
                  size="sm"
                  value={values.gradeBand}
                  disabled={!values.subject}
                  aria-invalid={errors.gradeBand ? true : undefined}
                  onChange={(e) =>
                    patch({ gradeBand: e.target.value, course: e.target.value === "HS" ? values.course : "" })
                  }
                >
                  <NativeSelectOption value="">Choose…</NativeSelectOption>
                  {bands.map((b) => (
                    <NativeSelectOption key={b} value={b}>
                      {gradeBandLabel(b)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {needsCourse(values) ? (
                <div className="space-y-1">
                  <label htmlFor={`${uid}-course`} className="block text-sm font-medium">
                    Course <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <NativeSelect
                    id={`${uid}-course`}
                    size="sm"
                    value={values.course}
                    onChange={(e) => patch({ course: e.target.value })}
                  >
                    <NativeSelectOption value="">Any course</NativeSelectOption>
                    {(facets?.courses ?? []).map((c) => (
                      <NativeSelectOption key={c} value={c}>
                        {c}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              {values.subject !== "science" ? (
                <div className="space-y-1">
                  <label htmlFor={`${uid}-scheme`} className="block text-sm font-medium">
                    Standards
                  </label>
                  <NativeSelect
                    id={`${uid}-scheme`}
                    size="sm"
                    value={values.scheme}
                    onChange={(e) => patch({ scheme: e.target.value as SuggestFormValues["scheme"] })}
                  >
                    <NativeSelectOption value="wa2026">2026 codes</NativeSelectOption>
                    <NativeSelectOption value="ccss2010">2011 codes</NativeSelectOption>
                  </NativeSelect>
                </div>
              ) : null}
            </div>
            {errors.subject || errors.gradeBand ? (
              <p role="alert" className="text-xs text-destructive">
                {errors.subject ?? errors.gradeBand}
              </p>
            ) : null}

            <div className="space-y-1">
              <label htmlFor={`${uid}-unit`} className="block text-sm font-medium">
                This unit&apos;s standards <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id={`${uid}-unit`}
                value={values.unitList}
                maxLength={SUGGEST_MAX_UNIT_LIST}
                onChange={(e) => patch({ unitList: e.target.value })}
                rows={4}
                placeholder="Paste the standards for this unit. Codes in the list narrow what the AI chooses from."
                aria-invalid={errors.unitList ? true : undefined}
              />
              {errors.unitList ? <p className="text-xs text-destructive">{errors.unitList}</p> : null}
            </div>
          </fieldset>

          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <span
                aria-hidden
                className="inline-block size-4 animate-spin rounded-full border-2 border-border border-t-foreground"
              />
              Suggesting standards…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="rounded border border-destructive/40 p-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button type="submit" disabled={!canSubmit || busy}>
              {busy ? "Suggesting…" : "Suggest"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
