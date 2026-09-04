import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempts, responses } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { loadUploadForItemIds } from "@/lib/api/responseUploads";
import { getStorageProviderById } from "@/lib/storage/provider";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ responseId: string }>;
}

/**
 * R0.2 (docs/reporting-design.md, finding F-1): nothing under app/ read
 * `response_uploads` back, so a saved drawing rendered blank in the review
 * queue. This streams the stored bytes for one drawing_upload response.
 *
 * Owner-scoped through the same response -> attempt -> assessment chain
 * `loadResponseChain` walks, but every failure here — wrong owner, no such
 * response, not a drawing, an incomplete slot, a storage miss — comes back
 * as 404. A teacher probing response ids must not be able to tell "not
 * yours" from "doesn't exist" from "no drawing yet", so none of those cases
 * gets a distinguishing status code.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { responseId } = await ctx.params;
  if (!UUID_RE.test(responseId)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const db = getDb();
  const [response] = await db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .limit(1);
  if (!response) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, response.attempt_id))
    .limit(1);
  if (!attempt) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, attempt.assessment_id))
    .limit(1);
  if (!assessment || assessment.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const stored = response.response as { type?: unknown; upload_id?: unknown } | null;
  if (
    !stored ||
    stored.type !== "drawing_upload" ||
    typeof stored.upload_id !== "string"
  ) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Scoped to this exact (attempt, item), same as the ingest route and the
  // P-1 delivery-bundle read — a response cannot be made to serve back
  // somebody else's file by naming their upload id.
  const upload = await loadUploadForItemIds(
    db,
    attempt.id,
    response.item_id,
    stored.upload_id,
  );
  if (!upload || upload.status !== "complete") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const provider = getStorageProviderById(upload.storage_provider);
  let bytes: Uint8Array;
  try {
    bytes = await provider.get(upload.storage_key);
  } catch (err) {
    console.warn(
      `response ${responseId}: could not read upload ${upload.id}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Slice to a plain ArrayBuffer — Bun's strict types reject the union of
  // ArrayBufferLike (which includes SharedArrayBuffer) as a BlobPart.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new NextResponse(new Blob([buf], { type: upload.content_type }), {
    status: 200,
    headers: {
      "content-type": upload.content_type,
      "content-length": String(bytes.byteLength),
      // A student's drawing — never a shared cache, never a disk cache.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
