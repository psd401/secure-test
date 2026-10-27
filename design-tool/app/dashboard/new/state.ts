/** Form state for the create-assessment action (kept out of the "use server" module, which may only export async functions). */
export interface CreateAssessmentState {
  // allow_llm_authoring: the start screen's AI draft (editor redesign Phase 8) only.
  fieldErrors: Partial<Record<"name" | "description" | "time_limit_minutes" | "allow_llm_authoring", string>>;
  values: { name: string; description: string; time_limit_minutes: string };
}

export const EMPTY_STATE: CreateAssessmentState = {
  fieldErrors: {},
  values: { name: "", description: "", time_limit_minutes: "" },
};
