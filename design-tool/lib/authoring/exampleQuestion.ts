import { ItemBundleSchema } from "@secure-test/schema";
import { planImport } from "@/lib/api/importBundle";
import { EXAMPLE_QUESTION_BUNDLE } from "./templates";

/**
 * The start screen's example question (Phase 8, D-5), server side only.
 * Kept out of `startScreen.ts` because the client editor imports that file
 * (editorStartAction) and `planImport` pulls in the database client, which
 * cannot be bundled for the browser.
 */

/** The example question's row, exactly as the import would store it (minus assessment_id). */
export function exampleQuestionRows() {
  const plan = planImport(ItemBundleSchema.parse(EXAMPLE_QUESTION_BUNDLE), new Map());
  return plan.rows;
}
