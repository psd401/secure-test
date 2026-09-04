import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessment_shares, assessments } from "@/db/schema";
import { roleForEmail } from "@/lib/auth/roles";
import type { SessionPayload } from "@/lib/auth/session";
import { buildExportBundle } from "@/lib/api/exportBundle";
import { importBundleForOwner, isImportBundleError } from "@/lib/api/importBundle";

// Slice C (2026-09-01): staff-to-staff sharing with COPY semantics.
//
// The owner offers an assessment to a colleague by staff email. The offer
// sits on the colleague's dashboard until they click "Add to my
// assessments", which builds the owner's lossless export bundle (hidden
// rubrics included — this is teacher-to-teacher, not student-facing) and
// imports it under the recipient's own owner_sub. From then on the two
// assessments are independent: the source stays single-owner, the copy is
// the recipient's to edit, publish, and run. No ownership check anywhere
// else in the app changes.

export const CreateShareBody = z.object({
  email: z.string().trim().min(3).max(320),
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type CreateShareFailure = {
  ok: false;
  status: 400 | 409;
  error:
    | "invalid_email"
    | "recipient_not_staff"
    | "cannot_share_with_self"
    | "already_shared"
    | "session_missing_email";
  hint: string;
};

export async function createShare(
  assessmentId: string,
  owner: SessionPayload,
  rawEmail: string,
): Promise<{ ok: true; share: typeof assessment_shares.$inferSelect } | CreateShareFailure> {
  const email = normalizeEmail(rawEmail);
  if (!email.includes("@") || /\s/.test(email)) {
    return { ok: false, status: 400, error: "invalid_email", hint: "Enter a colleague's district email address." };
  }
  if (roleForEmail(email, true) !== "staff") {
    return {
      ok: false,
      status: 400,
      error: "recipient_not_staff",
      hint: "Assessments can only be shared with staff district accounts.",
    };
  }
  const ownerEmail = owner.email ? normalizeEmail(owner.email) : null;
  if (!ownerEmail) {
    return {
      ok: false,
      status: 400,
      error: "session_missing_email",
      hint: "Sign out and back in, then try sharing again.",
    };
  }
  if (email === ownerEmail) {
    return { ok: false, status: 400, error: "cannot_share_with_self", hint: "That is your own address." };
  }
  const db = getDb();
  const [share] = await db
    .insert(assessment_shares)
    .values({
      assessment_id: assessmentId,
      recipient_email: email,
      shared_by_sub: owner.sub,
      shared_by_email: ownerEmail,
    })
    .onConflictDoNothing()
    .returning();
  if (!share) {
    return {
      ok: false,
      status: 409,
      error: "already_shared",
      hint: "This assessment is already shared with that address.",
    };
  }
  return { ok: true, share };
}

export async function listSharesForAssessment(assessmentId: string) {
  const db = getDb();
  return db
    .select()
    .from(assessment_shares)
    .where(eq(assessment_shares.assessment_id, assessmentId))
    .orderBy(desc(assessment_shares.created_at));
}

/** Offers addressed to this email, newest first, with the source's name. */
export async function listSharesForRecipient(email: string) {
  const db = getDb();
  return db
    .select({
      id: assessment_shares.id,
      assessment_id: assessment_shares.assessment_id,
      assessment_name: assessments.name,
      shared_by_email: assessment_shares.shared_by_email,
      created_at: assessment_shares.created_at,
      accepted_at: assessment_shares.accepted_at,
      copied_assessment_id: assessment_shares.copied_assessment_id,
    })
    .from(assessment_shares)
    .innerJoin(assessments, eq(assessments.id, assessment_shares.assessment_id))
    .where(eq(assessment_shares.recipient_email, normalizeEmail(email)))
    .orderBy(desc(assessment_shares.created_at));
}

export type AcceptShareResult =
  | { ok: true; assessment_id: string; already_added: boolean }
  | { ok: false; status: 403 | 404 | 409 | 500; error: string; detail?: string };

/**
 * Turn an offer into the recipient's own copy. Idempotent: a second call
 * returns the existing copy instead of making another.
 */
export async function acceptShare(
  shareId: string,
  recipient: SessionPayload,
): Promise<AcceptShareResult> {
  const db = getDb();
  const [share] = await db
    .select()
    .from(assessment_shares)
    .where(eq(assessment_shares.id, shareId))
    .limit(1);
  if (!share) return { ok: false, status: 404, error: "not_found" };
  const email = recipient.email ? normalizeEmail(recipient.email) : null;
  if (!email || email !== share.recipient_email) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (share.copied_assessment_id) {
    return { ok: true, assessment_id: share.copied_assessment_id, already_added: true };
  }
  const [source] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, share.assessment_id))
    .limit(1);
  if (!source) return { ok: false, status: 404, error: "source_gone" };

  const built = await buildExportBundle(db, source, source.owner_sub, true);
  if (!built.ok) {
    return {
      ok: false,
      status: built.status,
      error: `source_${built.error}`,
      detail: built.detail ?? built.item_id,
    };
  }
  const imported = await importBundleForOwner(built.bundle, recipient.sub);
  if (isImportBundleError(imported)) {
    return { ok: false, status: 500, error: `copy_${imported.error}` };
  }
  await db
    .update(assessment_shares)
    .set({ accepted_at: new Date(), copied_assessment_id: imported.assessment_id })
    .where(eq(assessment_shares.id, shareId));
  return { ok: true, assessment_id: imported.assessment_id, already_added: false };
}
