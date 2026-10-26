"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { assessments, items } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { CreateAssessmentBody } from "@/lib/api/assessments";
import { importBundleForOwner, isImportBundleError } from "@/lib/api/importBundle";
import { normalizeEmail } from "@/lib/roster/queries";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";
import {
  aiDraftAllowed,
  exampleQuestionRows,
  parseStartChoice,
  startRedirect,
} from "@/lib/authoring/startScreen";
import { templateById, templateBundle } from "@/lib/authoring/templates";

import type { CreateAssessmentState } from "./state";

/**
 * UX pass 1, slice 3 (SH-07, SH-08): validation failures come back to the
 * form with the field named and every typed value kept, instead of a redirect
 * that dropped the values and put a Zod message in the URL. Success lands the
 * teacher inside the new assessment. The AI-help checkbox moved to the
 * editor's Settings tab (slice 4); the column keeps its server default.
 */
export async function createAssessment(
  _prev: CreateAssessmentState,
  formData: FormData,
): Promise<CreateAssessmentState> {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/new");
  }

  const values = {
    name: String(formData.get("name") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    time_limit_minutes: String(formData.get("time_limit_minutes") ?? "").trim(),
  };
  const fieldErrors: CreateAssessmentState["fieldErrors"] = {};

  // Teachers think in minutes; the DB stores seconds so delivery-time timer
  // math is a subtraction. Blank means untimed.
  let time_limit_seconds: number | null = null;
  if (values.time_limit_minutes.length > 0) {
    const minutes = Number(values.time_limit_minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      fieldErrors.time_limit_minutes = "Time limit must be a whole number of minutes.";
    } else {
      time_limit_seconds = minutes * 60;
    }
  }
  if (values.name.length === 0) {
    fieldErrors.name = "Give the assessment a name.";
  }

  const parsed = CreateAssessmentBody.safeParse({
    name: values.name,
    description: values.description,
    time_limit_seconds,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "name" && !fieldErrors.name) {
        fieldErrors.name =
          values.name.length > 200 ? "Keep the name under 200 characters." : "Give the assessment a name.";
      } else if (field === "description" && !fieldErrors.description) {
        fieldErrors.description = "Keep the description under 2,000 characters.";
      }
    }
  }
  // Editor redesign Phase 8 (D-5): the start screen posts this same form with
  // a hidden `start`. It counts only with the R-12 flag on; today's form has
  // no such field, so its path below is unchanged.
  const db = getDb();
  let start = parseStartChoice(formData.get("start"));
  if (start && !(await isNewAuthoringEnabled(db, session))) start = null;
  const allowLlm = aiDraftAllowed(start, formData);
  if (start === "ai" && !allowLlm) {
    fieldErrors.allow_llm_authoring = "Tick “Allow AI help when writing questions” to draft with AI.";
  }

  if (Object.keys(fieldErrors).length > 0 || !parsed.success) {
    return { fieldErrors, values };
  }

  const withExample = start === "blank" && formData.get("with_example") === "on";
  const createdId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(assessments)
      .values({
        owner_sub: session.sub,
        // Finding OE-1: the key roster suggestions and teacher-scope grants
        // resolve through, as the API create path writes it.
        owner_email: normalizeEmail(session.email),
        name: parsed.data.name,
        description: parsed.data.description,
        time_limit_seconds: parsed.data.time_limit_seconds ?? null,
        // Phase 8: set only by the teacher's own tick on the AI draft.
        ...(allowLlm ? { allow_llm_authoring: true } : {}),
      })
      .returning({ id: assessments.id });
    if (withExample) {
      await tx.insert(items).values(exampleQuestionRows().map((r) => ({ ...r, assessment_id: created!.id })));
    }
    return created!.id;
  });
  redirect(startRedirect(createdId, start));
}

/**
 * Editor redesign Phase 8 (D-5, Q3): "Use this template". The template is a
 * checked-in ItemBundle (lib/authoring/templates.ts) and goes through the
 * .json import's own path, so the new draft is exactly what importing that
 * file would make. R-12 flag on only; otherwise back to the plain form.
 */
export async function createFromTemplate(formData: FormData): Promise<void> {
  const session = await readStaffSessionFromCookies();
  if (!session) {
    redirect("/login?next=/dashboard/new");
  }
  const db = getDb();
  const template = templateById(String(formData.get("template") ?? ""));
  if (!template || !(await isNewAuthoringEnabled(db, session))) {
    redirect("/dashboard/new");
  }
  const imported = await importBundleForOwner(
    templateBundle(template),
    session.sub,
    normalizeEmail(session.email),
  );
  if (isImportBundleError(imported)) {
    redirect(`/dashboard/new?error=${encodeURIComponent(imported.error)}`);
  }
  redirect(`/dashboard/${imported.assessment_id}`);
}
