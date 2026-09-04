import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireStudent } from "@/lib/api/requireSession";
import {
  alreadySubmitted,
  attemptAcceptsWrites,
  loadItemForAttempt,
  loadOwnAttempt,
  notFound,
} from "@/lib/api/studentAttempt";
import {
  UPLOAD_MAX_BYTES,
  UploadTooLargeError,
  isAllowedUploadType,
  registerUpload,
} from "@/lib/api/responseUploads";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ attemptId: string; itemId: string }>;
}

const Body = z.object({
  content_type: z.string().min(1).max(128),
  // Declared up front so the size limit can be applied BEFORE a URL exists. A
  // presigned PUT can bind an exact Content-Length but not a maximum, and once
  // the URL is out the upload never passes through this app again.
  content_length: z.number().int().positive().max(UPLOAD_MAX_BYTES),
});

/**
 * Slice 65: hand the client somewhere to put a drawing.
 *
 * Returns a registry id plus an upload target. The target is a presigned S3 URL
 * where the backend supports one, and an authenticated route back through this
 * app where it does not — the client treats both the same, which is why the
 * response says `direct` rather than making it guess from the URL.
 */
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStudent();
  if (!auth.ok) return auth.response;

  const { attemptId, itemId } = await ctx.params;
  if (!UUID_RE.test(attemptId) || !UUID_RE.test(itemId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (!isAllowedUploadType(body.content_type)) {
    // The content type is signed into the upload URL and later served back to a
    // teacher, so the allowlist is where "image" stops meaning "any bytes the
    // client labelled".
    return NextResponse.json(
      { ok: false, error: "unsupported_content_type" },
      { status: 400 },
    );
  }

  const db = getDb();
  const access = await loadOwnAttempt(db, attemptId, auth.session);
  if (!access.ok) return access.response;
  if (!attemptAcceptsWrites(access.attempt)) return alreadySubmitted();

  const item = await loadItemForAttempt(db, access.attempt, itemId);
  if (!item) return notFound();
  if (item.type !== "drawing_upload") {
    return NextResponse.json(
      { ok: false, error: "item_does_not_take_uploads" },
      { status: 400 },
    );
  }

  try {
    const { uploadId, upload } = await registerUpload(
      db,
      access.attempt,
      item,
      body.content_type.trim().toLowerCase(),
      body.content_length,
    );
    return NextResponse.json(
      { upload_id: uploadId, upload, max_bytes: UPLOAD_MAX_BYTES },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json({ ok: false, error: "upload_too_large" }, { status: 413 });
    }
    throw err;
  }
}
