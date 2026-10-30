import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { feedback_release_prefs } from "@/db/schema";
import { readReleaseContents } from "@/lib/googleDocs/sendDialog";
import type { ReleaseContents } from "@/lib/googleDocs/content";

// FR R-4 (docs/feedback-release-design.md): a teacher's last release choices
// per assessment. Box flags only — never student content — so nothing here
// is student-record data.

type Db = ReturnType<typeof getDb>;

/** The remembered boxes, or null when this teacher has not sent from this assessment. */
export async function loadFeedbackReleasePrefs(
  db: Db,
  staffSub: string,
  assessmentId: string,
): Promise<ReleaseContents | null> {
  const [row] = await db
    .select({ contents: feedback_release_prefs.contents })
    .from(feedback_release_prefs)
    .where(
      and(
        eq(feedback_release_prefs.staff_sub, staffSub),
        eq(feedback_release_prefs.assessment_id, assessmentId),
      ),
    )
    .limit(1);
  return row ? readReleaseContents(row.contents) : null;
}

/**
 * Remember the boxes just sent. The stored jsonb is MERGED with the new
 * flags, so a later writer with fewer keys (slice 4's packet has no prompt
 * or sources) leaves the others as the last Doc send set them.
 */
export async function rememberFeedbackReleasePrefs(
  db: Db,
  staffSub: string,
  assessmentId: string,
  contents: Record<string, boolean>,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(feedback_release_prefs)
    .values({ staff_sub: staffSub, assessment_id: assessmentId, contents, updated_at: now })
    .onConflictDoUpdate({
      target: [feedback_release_prefs.staff_sub, feedback_release_prefs.assessment_id],
      set: {
        contents: sql`${feedback_release_prefs.contents} || excluded.contents`,
        updated_at: now,
      },
    });
}
