import { NextResponse } from "next/server";
import { requireStudentOrPractice } from "@/lib/api/requireSession";
import {
  RENDERER_FILE_TYPES,
  SHA256_HEX_RE,
  isMissingObject,
  isRendererFileName,
  rendererObjectKey,
} from "@/lib/renderer/current";
import { getStorageProvider } from "@/lib/storage/provider";

interface RouteContext {
  params: Promise<{ sha256: string; file: string }>;
}

function notFound(): NextResponse {
  return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}

/**
 * The signed renderer's files, by the SHA-256 of their manifest
 * (docs/server-delivered-renderer-design.md D-1, slice 3 commit 4):
 * `manifest.json`, `manifest.sig`, `renderer.js`, `renderer.css`. The
 * delivery bundle names the hash; the shell fetches these, verifies the
 * signature and the file hashes itself, and caches them by hash.
 *
 * Anyone signed in — a student, or staff on a practice sitting — may fetch:
 * the code is public in the repository anyway, and the session only keeps
 * the route from being an anonymous file server. The session check is the
 * JWT ALONE (`requireStudentOrPractice` verifies the bearer token or cookie
 * and maps the role; it never queries the database), and nothing below
 * touches the database either: this route must answer while Aurora is
 * paused overnight (row AC), so a shell's fetch never waits on a cold
 * cluster. Storage is the only source.
 *
 * Files under a hash are immutable (`deploy.sh --staging` never rewrites
 * one), hence the year-long immutable cache. A name or hash outside the
 * allowed shapes is 404, the same as a missing object, so the route says
 * nothing about what exists.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const auth = await requireStudentOrPractice();
  if (!auth.ok) return auth.response;

  const { sha256, file } = await ctx.params;
  if (!SHA256_HEX_RE.test(sha256) || !isRendererFileName(file)) return notFound();

  let bytes: Uint8Array;
  try {
    bytes = await getStorageProvider().get(rendererObjectKey(sha256, file));
  } catch (err) {
    if (isMissingObject(err)) return notFound();
    throw err;
  }

  // Slice to a plain ArrayBuffer — Bun's strict types reject the union of
  // ArrayBufferLike (which includes SharedArrayBuffer) as a BlobPart.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const type = RENDERER_FILE_TYPES[file];
  return new NextResponse(new Blob([buf], { type }), {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
