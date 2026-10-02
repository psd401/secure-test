import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { LOOKUP_MAX_TAGS, lookupTags } from "@/lib/standards/search";

/**
 * BG slice 2: chip data for an item's stored tags. `?tags=a,b` (≤ 20) →
 * `{ entries: { [tag]: { code, scheme, text } | null } }` — null for a custom
 * designation or a code this catalog does not have, which the editor shows as
 * typed. Staff only; addresses no owned row.
 */
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const raw = new URL(req.url).searchParams.get("tags") ?? "";
  const tags = [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
  if (tags.length > LOOKUP_MAX_TAGS) {
    return NextResponse.json(
      { ok: false, error: "too_many_tags", max: LOOKUP_MAX_TAGS },
      { status: 400 },
    );
  }
  return NextResponse.json({ entries: lookupTags(tags) });
}
