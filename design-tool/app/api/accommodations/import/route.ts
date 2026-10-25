import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import { readBodyWithin } from "@/lib/api/jsonBody";
import {
  applyTideImport,
  parseTideXlsx,
  TideImportError,
} from "@/lib/api/importTide";
import { getDb } from "@/db/client";
import { stampOverlayOwnerEmail } from "@/lib/accommodations/coTeacherRecords";

// TIDE district exports are well under 25 MiB for a single year-group.
// Larger districts may need a larger cap; revisit when a real export
// surfaces.
const MAX_BYTES = 25 * 1024 * 1024;
// The whole multipart body: the file plus its part headers and boundaries.
const MAX_BODY_BYTES = MAX_BYTES + 64 * 1024;

// The .xlsx MIME from a browser File picker. Spreadsheet apps emit a
// few variants — accept the canonical one and the legacy fallback that
// some browsers still send.
const ALLOWED_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream", // some download paths strip the MIME
]);

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json(
      { ok: false, error: "expected_multipart" },
      { status: 400 },
    );
  }

  // SEC-08: the size check used to run after `formData()` had already
  // buffered the whole body. A declared length over the cap is refused
  // before a byte is read, and the body is then read with a byte counter
  // (`readBodyWithin`) so one that sends no length, or lies about it, stops
  // at the cap too. `file.size` below then only checks the file part.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", limit: MAX_BYTES },
      { status: 413 },
    );
  }

  const body = await readBodyWithin(req, MAX_BODY_BYTES);
  if (body === null) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", limit: MAX_BYTES },
      { status: 413 },
    );
  }

  let file: File;
  try {
    const form = await new Response(body, { headers: { "content-type": ct } }).formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "missing_file" },
        { status: 400 },
      );
    }
    file = candidate;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "form_parse_failed" },
      { status: 400 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", limit: MAX_BYTES },
      { status: 413 },
    );
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { ok: false, error: "unsupported_mime", mime: file.type },
      { status: 400 },
    );
  }

  const ab = await file.arrayBuffer();
  const buf = Buffer.from(ab);

  try {
    const parsed = await parseTideXlsx(buf);
    const result = await applyTideImport(parsed, auth.session.sub);
    // U-17: the rows this import made carry no owner email yet.
    await stampOverlayOwnerEmail(getDb(), auth.session.sub, auth.session.email);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof TideImportError) {
      return NextResponse.json(
        { ok: false, error: err.code, detail: err.message },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: "import_failed",
        detail: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 },
    );
  }
}
