"use server";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { authorizeAssessment } from "@/lib/api/access";
import { resolveAssessmentAssets } from "@/lib/assets/assessmentAssets";
import { extractAssetRefs } from "@/lib/items/extractAssetRefs";
import {
  renderItemContent,
  type ResolvedAsset,
} from "@/lib/items/renderItemContent";
import { UUID_RE } from "@/lib/uuid";

// Editor live-preview server action. Resolves image refs and runs the result
// through the unified renderItemContent (math + images). Replaces the
// slice-11 renderMath action — same shape, broader payload.
//
// G-1 (docs/coteacher-gaps-2026-10-design.md): with an `assessmentId` the
// caller can `view`, refs resolve under that assessment's OWNER and point at
// the assessment-scoped image URL, so a co-teacher's preview shows the
// owner's pictures. Without one (or without access), refs resolve on the
// caller's own shelf, as before.
export async function renderContent(text: string, assessmentId?: string): Promise<string> {
  const session = await readStaffSessionFromCookies();
  if (!session) return "";
  if (typeof text !== "string") return "";
  const capped = text.length > 10000 ? text.slice(0, 10000) : text;
  const refs = extractAssetRefs(capped);
  if (refs.length === 0) return renderItemContent(capped, new Map());

  const db = getDb();
  if (typeof assessmentId === "string" && UUID_RE.test(assessmentId)) {
    const access = await authorizeAssessment(db, session, assessmentId, "view", "read");
    if (access.ok) {
      return renderItemContent(
        capped,
        await resolveAssessmentAssets(db, access.assessment, refs),
      );
    }
  }

  const resolved = new Map<string, ResolvedAsset>();
  const rows = await db
    .select({ id: assets.id, content_type: assets.content_type })
    .from(assets)
    .where(and(eq(assets.owner_sub, session.sub), inArray(assets.id, refs)));
  for (const r of rows) {
    resolved.set(r.id.toLowerCase(), {
      id: r.id,
      content_type: r.content_type,
    });
  }
  return renderItemContent(capped, resolved);
}
