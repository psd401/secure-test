import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessmentAsset } from "@/lib/api/access";
import { assetResponse } from "@/lib/assets/assetResponse";

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

// G-1 (docs/coteacher-gaps-2026-10-design.md, D-1): an image as staff see it
// inside one assessment — `view` on the assessment, for an asset of the
// owner's that the assessment references (rules in authorizeAssessmentAsset).
// Every staff reader that renders assessment content points `<img>` here; the
// owner's own `/api/assets/[id]` stays for the Images page and uploads.
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id, assetId } = await ctx.params;
  const access = await authorizeAssessmentAsset(getDb(), auth.session, id, assetId);
  if (!access.ok) return access.response;
  return assetResponse(access.asset);
}
