import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { readImportBundle } from "@/lib/api/importBody";
import { previewImportBundle } from "@/lib/api/importPreview";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";

/**
 * Editor redesign Phase 7 slice C (R-9, D-6): what importing this
 * assessment file would create — counts by type, warnings, and the questions
 * as they will be stored — WITHOUT creating it. Same body as POST
 * /api/assessments/import (lib/api/importBody.ts: same caps, same refusals),
 * but nothing is written: the import page shows this, then Create sends the
 * file to the import itself.
 *
 * The response carries the file's answer keys back to the teacher who sent
 * the file (they are in it already); the page's student preview strips them
 * through the delivery projection before anything reaches the frame (ADR
 * 0019 §4). Staff with the R-12 flag on only; everyone else gets 404.
 */
export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const db = getDb();
  if (!(await isNewAuthoringEnabled(db, auth.session))) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const read = await readImportBundle(req);
  if (!read.ok) return read.response;
  const preview = await previewImportBundle(db, read.bundle, auth.session.sub);
  return NextResponse.json({ ok: true, preview }, { headers: { "cache-control": "no-store" } });
}
