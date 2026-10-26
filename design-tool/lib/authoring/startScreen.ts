import { ItemBundleSchema } from "@secure-test/schema";
import { planImport } from "@/lib/api/importBundle";
import { EXAMPLE_QUESTION_BUNDLE } from "./templates";

/**
 * Editor redesign Phase 8 (D-5): the start screen's choices that go through
 * the New assessment form. Each one creates an ordinary draft; what differs
 * is what the draft starts with and where the editor opens:
 *
 * - `blank`  — empty, or with one example question (EXAMPLE_QUESTION_BUNDLE);
 * - `import` — empty, with the PDF / Word import panel open (Phase 7);
 * - `ai`     — empty, with AI help turned on by the teacher on this form and
 *              the Generate questions dialog open.
 *
 * Templates and "Open a file" are not here: a template has its own action
 * (it goes through the import), and a .json file goes to /dashboard/import.
 */
export const START_CHOICES = ["blank", "import", "ai"] as const;
export type StartChoice = (typeof START_CHOICES)[number];

/** The form's hidden `start` field. Absent (today's New assessment form) or unknown is null. */
export function parseStartChoice(value: unknown): StartChoice | null {
  return typeof value === "string" && (START_CHOICES as readonly string[]).includes(value)
    ? (value as StartChoice)
    : null;
}

/** Where the new draft opens. `?start=` is read by the editor (editorStartAction). */
export function startRedirect(assessmentId: string, start: StartChoice | null): string {
  if (start === "import" || start === "ai") return `/dashboard/${assessmentId}?start=${start}`;
  return `/dashboard/${assessmentId}`;
}

/**
 * The AI draft's gate, kept to today's rule: AI authoring needs
 * `allow_llm_authoring` on the assessment, which is off by default and turned
 * on only by the teacher ticking "Allow AI help when writing questions" (the
 * Settings tab's own checkbox and wording). The start screen shows that same
 * checkbox, unticked; without it the AI draft is refused and nothing is made.
 * The generate route still checks the column itself (403
 * `llm_authoring_disabled`), so this is not the only line.
 */
export function aiDraftAllowed(start: StartChoice | null, formData: FormData): boolean {
  return start === "ai" && formData.get("allow_llm_authoring") === "on";
}

/**
 * What the editor does with `?start=` on first load. Only with the R-12 flag
 * on; `ai` only while the assessment allows AI help (the dialog is not even
 * rendered otherwise) and neither while the assessment is locked.
 */
export function editorStartAction(
  param: string | null,
  ctx: { newAuthoring: boolean; allowLlm: boolean; locked: boolean },
): "import" | "ai" | null {
  if (!ctx.newAuthoring || ctx.locked) return null;
  if (param === "import") return "import";
  if (param === "ai" && ctx.allowLlm) return "ai";
  return null;
}

/** The example question's row, exactly as the import would store it (minus assessment_id). */
export function exampleQuestionRows() {
  const plan = planImport(ItemBundleSchema.parse(EXAMPLE_QUESTION_BUNDLE), new Map());
  return plan.rows;
}
