import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  MAX_UPLOAD_BYTES,
  isAllowedImageMime,
  sha256Hex,
} from "@/lib/api/uploads";
import { getStorageProvider } from "@/lib/storage/provider";

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { ok: false, error: "expected_multipart_form_data" },
      { status: 415 },
    );
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const field = form.get("file");
    if (field instanceof File) file = field;
  } catch {
    return NextResponse.json(
      { ok: false, error: "form_parse_failed" },
      { status: 400 },
    );
  }
  if (!file) {
    return NextResponse.json(
      { ok: false, error: "missing_file" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { ok: false, error: "empty_file" },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", limit: MAX_UPLOAD_BYTES },
      { status: 413 },
    );
  }
  if (!isAllowedImageMime(file.type)) {
    return NextResponse.json(
      { ok: false, error: "unsupported_content_type", got: file.type },
      { status: 415 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = sha256Hex(bytes);

  const db = getDb();

  // Per-owner dedup: if the same bytes already exist for this user,
  // return the existing row. The (owner_sub, sha256) unique index
  // enforces this at the DB level too.
  const existing = await db
    .select()
    .from(assets)
    .where(and(eq(assets.owner_sub, auth.session.sub), eq(assets.sha256, sha)))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      { asset: existing[0], deduped: true },
      { status: 200 },
    );
  }

  const id = randomUUID();
  const provider = getStorageProvider();
  let storage_key: string;
  try {
    ({ storage_key } = await provider.put({
      id,
      bytes,
      content_type: file.type,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "storage_put_failed";
    return NextResponse.json(
      { ok: false, error: "storage_put_failed", detail: message },
      { status: 500 },
    );
  }

  let row;
  try {
    [row] = await db
      .insert(assets)
      .values({
        id,
        owner_sub: auth.session.sub,
        content_type: file.type,
        size_bytes: file.size,
        sha256: sha,
        storage_provider: provider.id,
        storage_key,
        original_filename: file.name || null,
      })
      .returning();
  } catch (err) {
    // Best-effort cleanup so we don't leak storage objects when the DB
    // insert fails (e.g. unique-index race against a concurrent upload
    // of the same bytes).
    try {
      await provider.delete(storage_key);
    } catch {}
    const message = err instanceof Error ? err.message : "db_insert_failed";
    return NextResponse.json(
      { ok: false, error: "db_insert_failed", detail: message },
      { status: 500 },
    );
  }

  return NextResponse.json({ asset: row, deduped: false }, { status: 201 });
}
