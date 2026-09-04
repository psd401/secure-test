"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { CreateAssessmentBody } from "@/lib/api/assessments";

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
  if (Object.keys(fieldErrors).length > 0 || !parsed.success) {
    return { fieldErrors, values };
  }

  const [created] = await getDb()
    .insert(assessments)
    .values({
      owner_sub: session.sub,
      name: parsed.data.name,
      description: parsed.data.description,
      time_limit_seconds: parsed.data.time_limit_seconds ?? null,
    })
    .returning({ id: assessments.id });
  redirect(`/dashboard/${created!.id}`);
}
