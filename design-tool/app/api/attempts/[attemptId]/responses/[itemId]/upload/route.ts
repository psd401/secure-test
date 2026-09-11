import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStudent } from "@/lib/api/requireSession";
import {
  alreadySubmitted,
  attemptAcceptsWrites,
  loadItemForAttempt,
  loadOwnAttempt,
  notFound,
} from "@/lib/api/studentAttempt";
import { refuseIfPastDeadline } from "@/lib/api/attemptDeadline";
import {
  UPLOAD_MAX_BYTES,
  loadUploadForItem,
  markUploadComplete,
} from "@/lib/api/responseUploads";
import { getStorageProviderById } from "@/lib/storage/provider";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string; itemId: string }>;
}

/**
 * Slice 65: the fallback upload target for backends that cannot presign
 * (local-fs in development). The bytes come through this app instead of going
 * straight to object storage.
 *
 * Everything the presigned path gets from the signature has to be enforced here
 * by hand — ownership of the slot, the declared content type, and the size cap
 * — because there is no signature to lean on.
 */
export async function PUT(req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId, itemId } = await ctx.params;
  if (!UUID_RE.test(attemptId) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const uploadId = new URL(req.url).searchParams.get("upload_id");
  if (!uploadId || !UUID_RE.test(uploadId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;
  if (!attemptAcceptsWrites(access.attempt)) return alreadySubmitted();
  // D-4: the drawing-slot completion is a write like any other — a canvas
  // finished after time is up does not land.
  const expired = await refuseIfPastDeadline(db, access.attempt);
  if (expired) return expired;

  const item = await loadItemForAttempt(db, access.attempt, itemId);
  if (!item) return notFound();

  const registered = await loadUploadForItem(db, access.attempt, item, uploadId);
  if (!registered) return notFound();

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ ok: false, error: "empty_upload" }, { status: 400 });
  }
  // Checked here as well as at registration. On the presigned path the
  // signature holds the client to its declared size; on this one there is no
  // signature, so the cap has to be re-applied against the bytes that actually
  // arrived rather than trusted from the declaration.
  if (bytes.byteLength > UPLOAD_MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "upload_too_large" }, { status: 413 });
  }

  const provider = getStorageProviderById(registered.storage_provider);
  await provider.put({
    id: registered.storage_key,
    bytes,
    content_type: registered.content_type,
  });
  await markUploadComplete(db, registered.id);

  return NextResponse.json({ ok: true, upload_id: registered.id });
}
