import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { acceptShare } from "@/lib/api/shares";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ shareId: string }>;
}

// Slice C: "Add to my assessments" — the recipient turns an offer into
// their own independent copy. Safe to call twice.
export async function POST(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { shareId } = await ctx.params;
  if (!UUID_RE.test(shareId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const result = await acceptShare(shareId, auth.session);
  if (!result.ok) {
    const { status, ...failure } = result;
    return NextResponse.json(failure, { status });
  }
  return NextResponse.json(result);
}
