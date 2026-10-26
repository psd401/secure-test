import { eq } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { staff_preferences } from "@/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { isImpersonating } from "@/lib/auth/admin";

type Db = ReturnType<typeof getDb>;

/**
 * R-12 (docs/editor-redesign-design.md): the one flag for the new authoring
 * experience. Every later slice (new editor, side-by-side preview, import
 * redesign, start screen) asks THIS function, so Phase 9's cutover is a
 * change to `NEW_AUTHORING_DEFAULT` and nothing else.
 *
 * Off unless the staff member has opted in. A missing row is the default.
 * An act-as session reads the TARGET teacher's choice (D-8: the admin sees
 * what the teacher sees).
 */
export const NEW_AUTHORING_DEFAULT = false;

export async function isNewAuthoringEnabled(
  db: Db,
  session: Pick<SessionPayload, "sub"> | null,
): Promise<boolean> {
  if (!session?.sub) return false;
  const [row] = await db
    .select({ on: staff_preferences.new_authoring })
    .from(staff_preferences)
    .where(eq(staff_preferences.staff_sub, session.sub))
    .limit(1);
  return row ? row.on : NEW_AUTHORING_DEFAULT;
}

export type SetNewAuthoringResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: "impersonating" };

/**
 * Opt in or out. Refused on an act-as session: the flag is the teacher's own
 * choice of tool, and an admin flipping it while acting as them would change
 * what the teacher sees on their next sign-in without their knowing.
 */
export async function setNewAuthoring(
  db: Db,
  session: SessionPayload,
  enabled: boolean,
): Promise<SetNewAuthoringResult> {
  if (isImpersonating(session)) return { ok: false, reason: "impersonating" };
  const now = new Date();
  await db
    .insert(staff_preferences)
    .values({ staff_sub: session.sub, new_authoring: enabled, updated_at: now })
    .onConflictDoUpdate({
      target: staff_preferences.staff_sub,
      set: { new_authoring: enabled, updated_at: now },
    });
  return { ok: true, enabled };
}
