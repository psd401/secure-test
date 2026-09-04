import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, assets, items, type ItemType } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  assetIdsFromItemConfig,
  extractAssetRefsFromMany,
} from "@/lib/items/extractAssetRefs";
import type { ResolvedAsset } from "@/lib/items/renderItemContent";
import { renderAssessmentHtml } from "@/lib/preview/renderHtml";
import { exportItemSets } from "@/lib/api/itemSetsBundle";
import { loadItemSetsInOrder } from "@/lib/api/itemSets";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// E17: the inlined <meta> CSP in lib/preview/renderHtml.ts must carry the same
// directives (minus frame-ancestors, which is header-only). Policies intersect
// — a directive missing from either one is denied, and this header cannot
// relax a narrower meta policy.
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'";

export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  // Slice 34: ?print=1 renders the paper/PDF variant (no banner/toolbar,
  // blank write-space). The teacher opens this in a new tab and Save-as-PDFs
  // from their own browser.
  const printMode = new URL(req.url).searchParams.get("print") === "1";
  const db = getDb();
  const [assessmentRow] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessmentRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (assessmentRow.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.assessment_id, id))
    .orderBy(asc(items.position));

  // Collect every asset uuid referenced by any stem or choice text, then
  // resolve in one owner-scoped lookup. Refs to non-existent or
  // non-owned assets are simply missing from the map; the renderer falls
  // back to a red `[image not found]` placeholder.
  // E5 slice 1: the sets and their stimuli; stimulus asset refs resolve
  // through the same owner-scoped lookup as stems.
  const plainSets = await exportItemSets(db, id, itemRows);
  // E12 slice 4: the preview shows a placeholder where a student's own
  // answer will go; the set loader carries the source's stem and name.
  const summaries = new Map((await loadItemSetsInOrder(id)).map((s) => [s.id, s.source ?? null]));
  const itemSets = plainSets.map((s) => ({
    ...s,
    source: summaries.get(s.id) ? { stem: summaries.get(s.id)!.stem, assessment_name: summaries.get(s.id)!.assessment_name } : null,
  }));
  const textsToScan: string[] = itemSets.map((s) => s.stimulus);
  for (const item of itemRows) {
    textsToScan.push(item.stem);
    const choices = (item.choices ?? []) as { id: string; text: string }[];
    for (const c of choices) textsToScan.push(c.text);
  }
  // Slices 49/50: hotspot + drawing reference images resolve through the
  // same owner-scoped lookup (assetIdsFromItemConfig drops non-uuid refs
  // so the uuid-column query can't 22P02).
  const refIds = [
    ...new Set([
      ...extractAssetRefsFromMany(textsToScan),
      ...itemRows.flatMap((r) => assetIdsFromItemConfig(r.config)),
    ]),
  ];
  const resolved = new Map<string, ResolvedAsset>();
  if (refIds.length > 0) {
    const ownedAssets = await db
      .select({ id: assets.id, content_type: assets.content_type })
      .from(assets)
      .where(
        and(
          eq(assets.owner_sub, auth.session.sub),
          inArray(assets.id, refIds),
        ),
      );
    for (const a of ownedAssets) {
      resolved.set(a.id.toLowerCase(), {
        id: a.id,
        content_type: a.content_type,
      });
    }
  }

  const html = renderAssessmentHtml(
    {
      id: assessmentRow.id,
      name: assessmentRow.name,
      allowed_accommodations: (assessmentRow.allowed_accommodations ??
        []) as string[],
    },
    itemRows.map((r) => ({
      id: r.id,
      position: r.position,
      type: r.type as ItemType,
      stem: r.stem,
      choices: (r.choices ?? []) as { id: string; text: string }[],
      correct_choice_ids: (r.correct_choice_ids ?? []) as string[],
      correct_answer: r.correct_answer,
      max_word_count: r.config?.max_word_count ?? null,
      placeholder: r.config?.placeholder ?? null,
      rubric: r.config?.rubric ?? null,
      pairs: r.config?.pairs ?? null,
      sequence: r.config?.sequence ?? null,
      // Slice 49: the key (correct_region_ids) deliberately stays behind.
      image_asset_id: r.config?.image_asset_id ?? null,
      regions: r.config?.regions ?? null,
      prompt_asset_id: r.config?.prompt_asset_id ?? null,
      canvas: r.config?.canvas ?? null,
      // E3 slice 1: the grid; the key (cell_keys) deliberately stays behind.
      columns: r.config?.columns ?? null,
      rows: r.config?.rows ?? null,
      corner: r.config?.corner ?? null,
    })),
    resolved,
    { printMode, itemSets },
  );

  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
