import { z } from "zod";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";

const UUID = z.string().uuid();
const ToolId = z
  .string()
  .refine(isValidAccommodationId, { message: "unknown_accommodation_id" });

// Single body used by both POST (create) and the natural upsert path
// the route handler implements — POSTing the same (student, tool)
// triple replaces the existing row's value.
export const UpsertOverrideBody = z.object({
  student_id: UUID,
  tool_id: ToolId,
  value: z.string().min(1).max(200),
});
export type UpsertOverrideBody = z.infer<typeof UpsertOverrideBody>;

export interface OverrideListItem {
  id: string;
  assessment_id: string;
  student_id: string;
  student_ssid: string;
  student_name: string;
  tool_id: string;
  value: string;
  created_by_sub: string;
  created_at: string;
  updated_at: string;
}
