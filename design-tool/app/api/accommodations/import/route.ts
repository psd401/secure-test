import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import {
  applyTideImport,
  parseTideXlsx,
  TideImportError,
} from "@/lib/api/importTide";

// TIDE district exports are well under 25 MiB for a single year-group.
// Larger districts may need a larger cap; revisit when a real export
// surfaces.
const MAX_BYTES = 25 * 1024 * 1024;

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

  let file: File;
  try {
    const form = await req.formData();
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
