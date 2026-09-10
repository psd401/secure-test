import { z } from "zod";
import { StudentLayoutSchema } from "@secure-test/schema";
import { ITEM_TYPES } from "@/db/schema";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";

const AccommodationId = z
  .string()
  .refine(isValidAccommodationId, { message: "unknown_accommodation_id" });
const AllowedAccommodations = z.array(AccommodationId);
const ConstructAltering = z.array(AccommodationId);

export const CreateAssessmentBody = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    time_limit_seconds: z.number().int().positive().nullable().optional(),
    allow_llm_authoring: z.boolean().optional().default(false),
    allow_clipboard: z.boolean().optional().default(false),
    // Client paging: default scroll (docs/client-paging-design.md, D-1).
    student_layout: StudentLayoutSchema.optional().default("scroll"),
    allowed_accommodations: AllowedAccommodations.optional().default([]),
    construct_altering: ConstructAltering.optional().default([]),
  })
  .superRefine((val, ctx) => {
    const allowed = new Set(val.allowed_accommodations);
    for (const id of val.construct_altering) {
      if (!allowed.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["construct_altering"],
          message: "construct_altering_must_be_subset",
        });
        return;
      }
    }
  });
export type CreateAssessmentBody = z.infer<typeof CreateAssessmentBody>;

export const UpdateAssessmentBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    time_limit_seconds: z.number().int().positive().nullable().optional(),
    allow_llm_authoring: z.boolean().optional(),
    allow_clipboard: z.boolean().optional(),
    student_layout: StudentLayoutSchema.optional(),
    allowed_accommodations: AllowedAccommodations.optional(),
    construct_altering: ConstructAltering.optional(),
    status: z.enum(["draft", "published"]).optional(),
    // Archive (docs/archive-and-delete-design.md, D-3). Status-only, like the
    // unlock: the route refuses a body that carries `archived` together with
    // anything else, so archiving can never smuggle an edit past the publish
    // lock.
    archived: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    // Subset check only when both arrays are present in the patch.
    // When only construct_altering is sent without allowed_accommodations,
    // the route handler must read the current row's allowed_accommodations
    // before applying the patch and call assertConstructAlteringSubset.
    if (val.construct_altering === undefined) return;
    if (val.allowed_accommodations === undefined) return;
    const allowed = new Set(val.allowed_accommodations);
    for (const id of val.construct_altering) {
      if (!allowed.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["construct_altering"],
          message: "construct_altering_must_be_subset",
        });
        return;
      }
    }
  });
export type UpdateAssessmentBody = z.infer<typeof UpdateAssessmentBody>;

/**
 * Cross-row subset assertion for PATCHes where the client sends one
 * array without the other. Returns the first offending id or null.
 */
export function findConstructAlteringSubsetViolation(
  allowed_accommodations: readonly string[],
  construct_altering: readonly string[],
): string | null {
  const allowed = new Set(allowed_accommodations);
  for (const id of construct_altering) {
    if (!allowed.has(id)) return id;
  }
  return null;
}

export const ChoiceShape = z.object({
  id: z.string().min(1),
  text: z.string(),
});

export const ItemBody = z.object({
  position: z.number().int().min(0),
  type: z.enum(ITEM_TYPES),
  stem: z.string().min(1),
  choices: z.array(ChoiceShape).default([]),
  correct_choice_ids: z.array(z.string()).default([]),
  correct_answer: z.string().nullable().optional(),
});
export type ItemBody = z.infer<typeof ItemBody>;
