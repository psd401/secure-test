"use server";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { readStaffSessionFromCookies } from "@/lib/auth/session";
import { extractAssetRefs } from "@/lib/items/extractAssetRefs";
import {
  renderItemContent,
  type ResolvedAsset,
} from "@/lib/items/renderItemContent";

// Editor live-preview server action. Resolves image refs against the
// session-scoped asset table and runs the result through the unified
// renderItemContent (math + images). Replaces the slice-11 renderMath
// action — same shape, broader payload.
export async function renderContent(text: string): Promise<string> {
  const session = await readStaffSessionFromCookies();
  if (!session) return "";
  if (typeof text !== "string") return "";
  const capped = text.length > 10000 ? text.slice(0, 10000) : text;
  const refs = extractAssetRefs(capped);
  const resolved = new Map<string, ResolvedAsset>();
  if (refs.length > 0) {
    const db = getDb();
    const rows = await db
      .select({ id: assets.id, content_type: assets.content_type })
      .from(assets)
      .where(
        and(eq(assets.owner_sub, session.sub), inArray(assets.id, refs)),
      );
    for (const r of rows) {
      resolved.set(r.id.toLowerCase(), {
        id: r.id,
        content_type: r.content_type,
      });
    }
  }
  return renderItemContent(capped, resolved);
}
