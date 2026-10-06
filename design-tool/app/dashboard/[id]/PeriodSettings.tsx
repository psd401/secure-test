"use client";

import { useEffect, useRef, useState } from "react";
import { VISIBLE_ACCOMMODATION_CATALOG } from "@/lib/accommodations/catalog";
import { tideValuesForTool } from "@/lib/accommodations/tideCatalog";
import type { SectionAccommodation, SectionAccommodations } from "@/lib/accommodations/sections";
import { applyTargets, applyToAllPeriods, overwrittenTargets } from "@/lib/accommodations/applyToAllPeriods";
import { createAutosave } from "@/lib/autosave";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";

export interface PeriodOption {
  ps_id: string;
  label: string;
  on_roster: boolean;
  configured: boolean;
}

const SAVE_ERRORS: Record<string, string> = {
  section_allowed_must_be_subset: "A period can't allow a tool this test doesn't (the test is assigned by the school or district).",
  grant_not_allowed: "A period can only give a tool it allows.",
  grant_value_off: "Pick a setting for each tool you give.",
  grant_repeated: "Each tool can be given once per period.",
  assessment_published_editing_locked: "Unpublish to change accommodations.",
};

/**
 * U-18 slice 4 (docs/coteach-and-section-accommodations-design.md, D-7):
 * per-class-period settings on the Allowed tab. "All periods" means the list
 * above; a period can use its own list (D-5) and give everyone in it a tool
 * (D-4). Autosaves the whole `section_accommodations` value, like the list
 * above. A period left on the test's list with nothing given is removed.
 */
export function PeriodSettings({
  assessmentId,
  testAllowed,
  initial,
  assignedScope,
  isLocked,
  selected,
  onSelect,
  onSaved,
}: {
  assessmentId: string;
  testAllowed: readonly string[];
  initial: SectionAccommodations;
  assignedScope: string;
  isLocked: boolean;
  selected: string | null;
  onSelect: (psId: string | null) => void;
  onSaved: () => void;
}) {
  const [config, setConfig] = useState<SectionAccommodations>(initial);
  const [options, setOptions] = useState<PeriodOption[] | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // U-20: the period whose "Apply to all my periods" is waiting on a confirm.
  const [confirmApply, setConfirmApply] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/assessments/${assessmentId}/section-options`)
      .then((r) => (r.ok ? r.json() : { sections: [] }))
      .then((body: { sections: PeriodOption[] }) => {
        if (!cancelled) setOptions(body.sections);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [assessmentId]);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const autosave = useRef<ReturnType<typeof createAutosave<SectionAccommodations>> | null>(null);
  if (autosave.current === null) {
    autosave.current = createAutosave<SectionAccommodations>({
      delayMs: 600,
      save: async (value) => {
        const res = await fetch(`/api/assessments/${assessmentId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ section_accommodations: value }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(SAVE_ERRORS[body.error ?? ""] ?? "Couldn't save the period settings.");
        }
        onSavedRef.current();
      },
      onState: (state, err) => {
        if (state === "saving") setSave({ kind: "saving" });
        else if (state === "saved") setSave({ kind: "saved", at: new Date() });
        else if (state === "failed")
          setSave({ kind: "failed", message: err instanceof Error ? err.message : "Couldn't save." });
      },
    });
  }
  useEffect(() => () => void autosave.current?.flush(), []);

  function commit(out: SectionAccommodations) {
    setConfig(out);
    autosave.current?.schedule(out);
  }

  function update(psId: string, next: SectionAccommodation | null) {
    if (isLocked) return;
    setConfirmApply(null);
    const out = { ...config };
    if (!next || (next.allowed === null && next.grants.length === 0)) delete out[psId];
    else out[psId] = next;
    commit(out);
  }

  function applyToAll(psId: string, targets: string[]) {
    if (isLocked) return;
    setConfirmApply(null);
    commit(applyToAllPeriods(config, psId, targets));
  }

  const narrowOnly = assignedScope !== "teacher";
  const current: SectionAccommodation | null = selected ? (config[selected] ?? { allowed: null, grants: [] }) : null;
  const periodAllowed = current ? (current.allowed ?? [...testAllowed]) : [];
  const listChoices = VISIBLE_ACCOMMODATION_CATALOG.filter((e) => !narrowOnly || testAllowed.includes(e.id));
  const grantChoices = VISIBLE_ACCOMMODATION_CATALOG.filter((e) => periodAllowed.includes(e.id));

  function setOwnList(useOwn: boolean) {
    if (!selected || !current) return;
    const allowed = useOwn ? [...testAllowed] : null;
    const effective = allowed ?? [...testAllowed];
    update(selected, { allowed, grants: current.grants.filter((g) => effective.includes(g.tool_id)) });
  }

  function toggleAllowed(toolId: string) {
    if (!selected || !current || current.allowed === null) return;
    const allowed = current.allowed.includes(toolId)
      ? current.allowed.filter((id) => id !== toolId)
      : [...current.allowed, toolId];
    update(selected, { allowed, grants: current.grants.filter((g) => allowed.includes(g.tool_id)) });
  }

  function setGrant(toolId: string, value: string | null) {
    if (!selected || !current) return;
    const others = current.grants.filter((g) => g.tool_id !== toolId);
    update(selected, { allowed: current.allowed, grants: value ? [...others, { tool_id: toolId, value }] : others });
  }

  const targets = selected ? applyTargets(options ?? [], selected) : [];
  const overwritten = selected ? overwrittenTargets(config, selected, targets) : [];
  const labelOf = (psId: string) => (options ?? []).find((o) => o.ps_id === psId)?.label ?? `Section ${psId}`;

  const optionLabel = (o: PeriodOption) =>
    `${o.label}${config[o.ps_id] ? " · own settings" : ""}${o.on_roster ? "" : " (no longer on a class list)"}`;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="by-period">
      <h3 id="by-period" className="font-semibold">
        By class period
      </h3>
      <p className="text-xs text-muted-foreground">
        Give one class period its own list, or give everyone in it a tool. Periods you don&apos;t set use the
        list above.
      </p>
      <div className="space-y-1">
        <Label htmlFor="period-picker">Settings for</Label>
        <NativeSelect
          id="period-picker"
          value={selected ?? ""}
          onChange={(e) => {
            setConfirmApply(null);
            onSelect(e.target.value === "" ? null : e.target.value);
          }}
          disabled={options === null}
        >
          <NativeSelectOption value="">All periods (the list above)</NativeSelectOption>
          {(options ?? []).map((o) => (
            <NativeSelectOption key={o.ps_id} value={o.ps_id}>
              {optionLabel(o)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {selected && current ? (
        <fieldset disabled={isLocked} className="block space-y-4 disabled:opacity-60">
          <div className="space-y-1.5 text-sm" role="radiogroup" aria-label="Allowed tools for this period">
            <label className="flex items-center gap-2">
              <input type="radio" checked={current.allowed === null} onChange={() => setOwnList(false)} />
              Use the test&apos;s list
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={current.allowed !== null} onChange={() => setOwnList(true)} />
              Use a different list for this period
            </label>
          </div>

          {current.allowed !== null ? (
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {listChoices.map((e) => (
                <label key={e.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={current.allowed!.includes(e.id)}
                    onChange={() => toggleAllowed(e.id)}
                  />
                  <span>{e.label}</span>
                </label>
              ))}
              {narrowOnly ? (
                <p className="text-xs text-muted-foreground md:col-span-2">
                  This test is assigned by the school or district, so a period can only narrow its list.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <div className="text-sm font-medium">Give everyone in this period</div>
            {grantChoices.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tools are allowed for this period.</p>
            ) : (
              grantChoices.map((e) => {
                const grant = current.grants.find((g) => g.tool_id === e.id);
                const values = tideValuesForTool(e.id).filter((v) => !/^(off|none)/i.test(v));
                const choices = values.length > 0 ? values : ["On"];
                return (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!grant}
                        onChange={() => setGrant(e.id, grant ? null : choices[0]!)}
                      />
                      <span>{e.label}</span>
                    </label>
                    {grant && choices.length > 1 ? (
                      <NativeSelect
                        aria-label={`${e.label} setting`}
                        value={grant.value}
                        onChange={(ev) => setGrant(e.id, ev.target.value)}
                      >
                        {choices.map((v) => (
                          <NativeSelectOption key={v} value={v}>
                            {v}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          {config[selected] ? (
            <div className="flex flex-wrap gap-2">
              {targets.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    overwritten.length > 0 ? setConfirmApply(selected) : applyToAll(selected, targets)
                  }
                >
                  Apply to all my periods
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => update(selected, null)}>
                Remove this period&apos;s settings
              </Button>
            </div>
          ) : null}

          {confirmApply === selected && overwritten.length > 0 ? (
            <div role="alertdialog" aria-labelledby="apply-all-confirm" className="space-y-2 rounded-md border p-3 text-sm">
              <p id="apply-all-confirm">
                This replaces the settings already on {overwritten.map(labelOf).join(", ")}. Every other period
                you teach gets this period&apos;s settings too.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => applyToAll(selected, targets)}>
                  Replace and apply
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmApply(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      <StatusLine state={save} />
    </section>
  );
}
