"use client";

import { createContext, useContext, type ReactNode } from "react";

// G-1 (docs/coteacher-gaps-2026-10-design.md): the editor's live previews
// (MathPreview, RenderedText) pass the open assessment's id to renderContent,
// which then resolves images under the assessment's owner with the
// assessment-scoped URL. Outside an assessment the id is null and images
// resolve on the caller's own shelf, as before.
const AssessmentIdContext = createContext<string | null>(null);

export function AssessmentIdProvider({ id, children }: { id: string; children: ReactNode }) {
  return <AssessmentIdContext.Provider value={id}>{children}</AssessmentIdContext.Provider>;
}

export function useAssessmentId(): string | null {
  return useContext(AssessmentIdContext);
}
