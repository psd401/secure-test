/**
 * Teacher feedback (docs/feedback-release-design.md, D-4 / D-12): the PUT body
 * both feedback routes take. Trimmed, then 1..TEACHER_FEEDBACK_MAX characters —
 * checked here so the DB CHECK never fires (D-14: its error would carry the
 * text). Clearing a comment is DELETE, not an empty PUT.
 */

import { z } from "zod";
import { TEACHER_FEEDBACK_MAX } from "@/lib/teacherFeedback/limits";

export const TeacherFeedbackBody = z.object({
  text: z.string().trim().min(1).max(TEACHER_FEEDBACK_MAX),
});
export type TeacherFeedbackBody = z.infer<typeof TeacherFeedbackBody>;
