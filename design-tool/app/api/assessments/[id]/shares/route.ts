import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { loadOwnedAssessment } from "@/lib/api/loadOwned";
import { CreateShareBody, createShare, listSharesForAssessment } from "@/lib/api/shares";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Slice C: the owner's view of who an assessment is shared with.
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  return NextResponse.json({ shares: await listSharesForAssessment(id) });
}

// Slice C: offer this assessment to a colleague by staff email. Any status
// (draft or published) can be shared — the copy starts as the recipient's
// draft either way.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  let body;
  try {
    body = CreateShareBody.parse(await req.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json({ ok: false, error: "invalid_body", detail: message }, { status: 400 });
  }
  const owned = await loadOwnedAssessment(id, auth.session.sub);
  if (owned.status !== 200) {
    return NextResponse.json(
      { ok: false, error: owned.status === 404 ? "not_found" : "forbidden" },
      { status: owned.status },
    );
  }
  const result = await createShare(id, auth.session, body.email);
  if (!result.ok) {
    const { status, ...failure } = result;
    return NextResponse.json(failure, { status });
  }
  return NextResponse.json({ ok: true, share: result.share }, { status: 201 });
}
