import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment, notFoundResponse } from "@/lib/api/access";
import { listItemSnapshots } from "@/lib/authoring/itemHistory";
import { versionStemHtml } from "@/lib/authoring/versionStemHtml";
import { resolveAssessmentAssets } from "@/lib/assets/assessmentAssets";
import { extractAssetRefs } from "@/lib/items/extractAssetRefs";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string; itemId: string }>;
}

/**
 * R-5 (docs/editor-redesign-design.md): an item's earlier versions, newest
 * first, for the new editor's History view. Each version comes back as an
 * item row (the current id, position and set, the version's content) so the
 * editor reads it with the same flattening as any other row; restoring is an
 * ordinary PATCH of that content (`?restore=1`), never a write here.
 *
 * `edit` access, like the item GET: a version carries the answer key, and
 * only someone who could restore it needs to see it. Teacher plane only.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, itemId } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, id, "edit", "read");
  if (!access.ok) return access.response;
  const [item] = await db
    .select({ id: items.id, position: items.position, item_set_id: items.item_set_id })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.assessment_id, id)))
    .limit(1);
  if (!item) return notFoundResponse();
  const versions = await listItemSnapshots(db, itemId);
  // `stem_html`: the version's question as it looks, for the History list.
  // Pictures resolve under the assessment's owner, as in the live preview.
  const refs = [...new Set(versions.flatMap((v) => extractAssetRefs(v.content.stem ?? "")))];
  const resolved = await resolveAssessmentAssets(db, access.assessment, refs);
  return NextResponse.json({
    versions: versions.map((v) => ({
      id: v.id,
      saved_at: v.saved_at.toISOString(),
      captured_at: v.captured_at.toISOString(),
      item: { ...v.content, ...item },
      stem_html: versionStemHtml(v.content, resolved),
    })),
  });
}
