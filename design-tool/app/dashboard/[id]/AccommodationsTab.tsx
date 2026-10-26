"use client";

import type { Dispatch, SetStateAction } from "react";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import { WhoGetsWhat } from "./WhoGetsWhat";
import { PeriodSettings } from "./PeriodSettings";
import type { AccommodationCatalogEntry, OspiTier } from "@/lib/accommodations/catalog";
import { type AssessmentView, OSPI_TIER_LABEL, OSPI_TIER_ORDER } from "./editorModel";

/** Phase 4 slice D: the "Allowed on this test" tab's panel, moved unchanged
 * out of AssessmentEditor.tsx. Every value and handler is the editor's own. */
export interface AccommodationsTabProps {
  assessment: AssessmentView;
  isLocked: boolean;
  refresh: () => void;
  accommodationsByOspi: Map<OspiTier, AccommodationCatalogEntry[]>;
  allowedAccommodations: Set<string>;
  toggleAccommodation: (id: string) => void;
  constructAltering: Set<string>;
  toggleConstructAltering: (id: string) => void;
  accomSave: SaveState;
  selectedPeriod: string | null;
  setSelectedPeriod: Dispatch<SetStateAction<string | null>>;
}

export function AccommodationsTab(props: AccommodationsTabProps) {
  const {
    assessment,
    isLocked,
    refresh,
    accommodationsByOspi,
    allowedAccommodations,
    toggleAccommodation,
    constructAltering,
    toggleConstructAltering,
    accomSave,
    selectedPeriod,
    setSelectedPeriod,
  } = props;
  return (
    <section className="space-y-4">
      <fieldset
        disabled={isLocked}
        className="block space-y-4 disabled:opacity-60"
      >
        <legend className="text-sm font-medium">
          Allowed accommodations{" "}
          <span className="font-normal text-muted-foreground">
            ({allowedAccommodations.size} selected)
          </span>
        </legend>
        <p className="text-xs text-muted-foreground">
          Which tools students may use on this test. Ticking a tool gives it
          to no one by itself: a student gets it when it is on their Students
          page record, which carries over to every test, or when you add it
          on &ldquo;Exceptions for this test&rdquo;. Tick &ldquo;Changes what
          is measured&rdquo; when a tool alters the skill being tested (for
          example, text-to-speech on a reading test) so results can be
          reported separately.
        </p>
        {OSPI_TIER_ORDER.map((ospiTier) => {
          const entries = accommodationsByOspi.get(ospiTier) ?? [];
          if (entries.length === 0) return null;
          return (
            <div key={ospiTier} className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {OSPI_TIER_LABEL[ospiTier]}
              </div>
              <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                {entries.map((entry) => {
                  const checked = allowedAccommodations.has(entry.id);
                  const ca = constructAltering.has(entry.id);
                  return (
                    <div
                      key={entry.id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <label
                        className="flex flex-1 items-start gap-2"
                        title={entry.notes ?? undefined}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAccommodation(entry.id)}
                          className="mt-1"
                        />
                        <span className="flex-1">{entry.label}</span>
                      </label>
                      {checked ? (
                        <label
                          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                          title="This tool changes the skill being measured on this assessment (for example, text-to-speech on a reading test). Results can be reported separately."
                        >
                          <input
                            type="checkbox"
                            checked={ca}
                            onChange={() =>
                              toggleConstructAltering(entry.id)
                            }
                            className="mt-0.5"
                          />
                          <span>Changes what is measured</span>
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </fieldset>

      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Changes save automatically.
        </span>
        <StatusLine state={accomSave} />
      </div>

      <PeriodSettings
        assessmentId={assessment.id}
        testAllowed={assessment.allowed_accommodations}
        initial={assessment.section_accommodations}
        assignedScope={assessment.assigned_scope}
        isLocked={isLocked}
        selected={selectedPeriod}
        onSelect={setSelectedPeriod}
        onSaved={refresh}
      />

      <WhoGetsWhat
        assessmentId={assessment.id}
        section={selectedPeriod}
        savedKey={`${[...assessment.allowed_accommodations].sort().join(",")}|${[...assessment.construct_altering].sort().join(",")}|${JSON.stringify(assessment.section_accommodations)}`}
      />
    </section>
  );
}
