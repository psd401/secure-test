// R-12 (docs/editor-redesign-design.md): the staff member's own opt-in to the
// new authoring experience.
//
// GET answers `{ new_authoring }`. POST takes either JSON
// `{ new_authoring: boolean }` (answers JSON) or a plain form field
// `new_authoring=on|off` (redirects 303 back to /dashboard/beta), so the
// opt-in page works without JavaScript, like Sign out and Stop.
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { JSON_BODY_LIMITS, readBodyWithin, readJsonBody } from "@/lib/api/jsonBody";
import { requireStaff } from "@/lib/api/requireSession";
import { appOrigin } from "@/lib/auth/appOrigin";
import { isNewAuthoringEnabled, setNewAuthoring } from "@/lib/authoring/flag";

const JsonBody = z.object({ new_authoring: z.boolean() }).strict();

export async function GET() {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const on = await isNewAuthoringEnabled(getDb(), auth.session);
  return NextResponse.json({ new_authoring: on });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const isForm = (req.headers.get("content-type") ?? "").includes(
    "application/x-www-form-urlencoded",
  );
  let enabled: boolean;
  if (isForm) {
    const bytes = await readBodyWithin(req, JSON_BODY_LIMITS.small);
    if (bytes === null) {
      return NextResponse.json({ ok: false, error: "body_too_large" }, { status: 413 });
    }
    const value = new URLSearchParams(new TextDecoder().decode(bytes)).get("new_authoring");
    if (value !== "on" && value !== "off") {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
    enabled = value === "on";
  } else {
    const bodyRead = await readJsonBody(req, JSON_BODY_LIMITS.small);
    if (!bodyRead.ok) return bodyRead.response;
    let raw: unknown;
    try {
      raw = bodyRead.parse();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
    const parsed = JsonBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
    enabled = parsed.data.new_authoring;
  }

  const result = await setNewAuthoring(getDb(), auth.session, enabled);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason }, { status: 403 });
  }
  if (isForm) {
    return NextResponse.redirect(new URL("/dashboard/beta", appOrigin(req)).toString(), {
      status: 303,
    });
  }
  return NextResponse.json({ ok: true, new_authoring: result.enabled });
}
