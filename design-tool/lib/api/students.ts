import { z } from "zod";
import { TIDE_SUBJECTS, ACCOMMODATION_SOURCES } from "@/db/schema";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";

export const SUBJECT_ENUM = z.enum(TIDE_SUBJECTS);
export const SOURCE_ENUM = z.enum(ACCOMMODATION_SOURCES);

const Grade = z.string().max(8).nullable().optional();
const School = z.string().max(120).nullable().optional();

export const CreateStudentBody = z.object({
  ssid: z.string().min(1).max(64),
  name: z.string().max(200).optional().default(""),
  grade: Grade,
  school: School,
});
export type CreateStudentBody = z.infer<typeof CreateStudentBody>;

export const UpdateStudentBody = z.object({
  name: z.string().max(200).optional(),
  grade: Grade,
  school: School,
});
export type UpdateStudentBody = z.infer<typeof UpdateStudentBody>;

const ToolId = z
  .string()
  .refine(isValidAccommodationId, { message: "unknown_accommodation_id" });

export const UpsertManualAccommodationBody = z.object({
  subject: SUBJECT_ENUM,
  tool_id: ToolId,
  value: z.string().min(1).max(200),
});
export type UpsertManualAccommodationBody = z.infer<
  typeof UpsertManualAccommodationBody
>;

export const EditAccommodationValueBody = z.object({
  value: z.string().min(1).max(200),
});
export type EditAccommodationValueBody = z.infer<
  typeof EditAccommodationValueBody
>;

// What the TIDE import route returns to the caller. The dedicated diff
// review screen consumes `diffs` to surface kept-vs-TIDE choices.
export interface ImportTideDiff {
  accommodation_id: string;
  ssid: string;
  subject: string;
  tool_id: string;
  kept_value: string;
  tide_value: string;
}

export interface ImportTideResult {
  students_added: number;
  students_updated: number;
  rows_inserted: number;
  rows_overwritten: number;
  rows_preserved_with_diff: number;
  rows_soft_removed: number;
  rows_dropped: number;
  /** D12: existing accommodations kept because TIDE sent an unmappable value. */
  rows_removal_suppressed: number;
  /** D12: students whose soft-remove sweep was skipped (unmappable tool name). */
  students_sweep_skipped: number;
  diffs: ImportTideDiff[];
}

export const StudentListItem = z.object({
  id: z.string().uuid(),
  ssid: z.string(),
  name: z.string(),
  grade: z.string().nullable(),
  school: z.string().nullable(),
  accommodation_count: z.number().int().nonnegative(),
});
export type StudentListItem = z.infer<typeof StudentListItem>;
