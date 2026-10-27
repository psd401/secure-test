import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireStaff } from "@/lib/api/requireSession";
import { isNewAuthoringEnabled } from "@/lib/authoring/flag";
import { buildPreviewShell } from "@/lib/preview/interactive/shell";
import { loadPreviewRenderer, staticShellParts } from "@/lib/preview/interactive/shellParts";

/**
 * The interactive editor preview's frame document (editor redesign Phase 5
 * slice B; ADR 0019, Proposed). It is the same bytes for every assessment —
 * no item content, no answer key, so there is no owned row to authorize: the
 * editor page posts the content in over a MessageChannel after the frame's
 * `ready` (lib/preview/interactive/protocol.ts).
 *
 * Staff only (defense in depth: the frame is opaque-origin, so its own
 * requests carry no cookie anyway), and only for staff with the R-12 flag on —
 * everyone else gets 404, as if the route did not exist. `/preview/[id]`
 * (ADR 0006, the static preview) is untouched and still serves every editor
 * with the flag off.
 *
 * The CSP pins exactly three scripts by hash (bootstrap, KaTeX, renderer),
 * computed from the bytes in this response. Cached privately for five
 * minutes: the editor loads a fresh frame for each live refresh, and the
 * document is ~2 MB (renderer, KaTeX, inlined fonts).
 */
export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  if (!(await isNewAuthoringEnabled(getDb(), auth.session))) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const renderer = await loadPreviewRenderer();
  if (!renderer) {
    // Shown inside the frame; static text only, no script.
    return new NextResponse(
      "<!doctype html><meta charset=utf-8><title>Student preview</title>" +
        "<p style=\"font:16px system-ui,sans-serif;padding:1rem\">The student preview is not available on this server yet.</p>",
      {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }

  const shell = buildPreviewShell({ ...staticShellParts(), rendererJs: renderer.js, rendererCss: renderer.css });
  return new NextResponse(shell.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": shell.csp,
      "cache-control": "private, max-age=300",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-preview-renderer": renderer.origin,
    },
  });
}
