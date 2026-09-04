import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { getStorageProviderById } from "@/lib/storage/provider";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (row.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const provider = getStorageProviderById(row.storage_provider);
  let bytes: Uint8Array;
  try {
    bytes = await provider.get(row.storage_key);
  } catch (err) {
    const message = err instanceof Error ? err.message : "storage_get_failed";
    return NextResponse.json(
      { ok: false, error: "storage_get_failed", detail: message },
      { status: 500 },
    );
  }

  // Slice to a plain ArrayBuffer — Bun's strict types reject the union of
  // ArrayBufferLike (which includes SharedArrayBuffer) as a BlobPart.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new NextResponse(new Blob([buf], { type: row.content_type }), {
    status: 200,
    headers: {
      "content-type": row.content_type,
      "content-length": String(row.size_bytes),
      // URL contains a uuid that's only known to the owner; per-browser
      // caching is fine, shared caches are not.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (row.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const provider = getStorageProviderById(row.storage_provider);
  await db.delete(assets).where(eq(assets.id, id));
  // Best-effort delete from storage — if it fails, the DB row is gone
  // and the orphaned file is harmless local state. A future janitor
  // pass would sweep these up.
  try {
    await provider.delete(row.storage_key);
  } catch (err) {
    console.warn(
      `asset ${id} DB-deleted but storage delete failed:`,
      err instanceof Error ? err.message : err,
    );
  }
  return new NextResponse(null, { status: 204 });
}
