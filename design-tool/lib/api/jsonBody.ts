// JSON request bodies, read with a ceiling (2026-10-25).
//
// `req.json()` buffers whatever the caller sends, and nothing in front of the
// route handlers caps it (Next's 1 MB default covers server actions only).
// zod 3.25 then multiplies the cost: an array of wrong-typed elements keeps
// one issue object per element (advisory GHSA-mrhx-c7xc-m3w5 — a 2 MB array
// measured ~224 MB of heap). Every API route reads its JSON through
// `readJsonBody` instead; test/json-body-cap.test.ts refuses a direct
// `req.json()` under app/api.
//
// The tiers come from production's stored payload sizes (`oneoff-aurora.sh
// payload-sizes`, 2026-10-25: largest stored item 8.7 KiB, answer 13.9 KiB,
// item set 13.8 KiB) and, where a schema allows more than that, from the
// schema's own maximum.
import { NextResponse } from "next/server";

export const JSON_BODY_LIMITS = {
  /** Events (4 KiB detail cap), feedback (2,000-char message). */
  small: 16 * 1024,
  /** Everything else: ~18x the largest payload stored in production. */
  default: 256 * 1024,
  /**
   * Long text the schemas allow: an answer (essay 100,000 chars + 200,000 of
   * HTML), a client error batch (50 entries from a 512 KiB log), rubric or
   * resource text (200,000 chars).
   */
  longText: 1024 * 1024,
  /** Peek screenshot: 2,000,000 base64 chars. */
  peekImage: 3 * 1024 * 1024,
  /** Items CSV import: 2,000,000 chars, which JSON escaping can double. */
  csvImport: 5 * 1024 * 1024,
} as const;

export type JsonBodyRead =
  | { ok: true; parse: () => unknown }
  | { ok: false; response: NextResponse };

/**
 * Read the body as JSON text, refusing `413 body_too_large` once it passes
 * `maxBytes` — from a declared Content-Length before a byte is read, or by
 * counting bytes as they arrive (a length can be absent or false). `parse()`
 * throws on malformed JSON exactly as `req.json()` did, so each route keeps
 * its own 400 for a bad body.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<JsonBodyRead> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(maxBytes);
  const bytes = await readBodyWithin(req, maxBytes);
  if (bytes === null) return tooLarge(maxBytes);
  const text = new TextDecoder().decode(bytes);
  return { ok: true, parse: () => JSON.parse(text) as unknown };
}

function tooLarge(limit: number): JsonBodyRead {
  return {
    ok: false,
    response: NextResponse.json({ ok: false, error: "body_too_large", limit }, { status: 413 }),
  };
}

/** The request body, or `null` once it passes `max` bytes (SEC-08). */
export async function readBodyWithin(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
