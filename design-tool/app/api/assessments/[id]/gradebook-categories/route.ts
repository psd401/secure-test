import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { gradebook_section_prefs } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeSend } from "@/lib/gradebook/authorizeSend";
import { missingPowerSchoolIds } from "@/lib/gradebook/mapping";
import {
  GradebookConfigError,
  GradebookHttpError,
  getPowerSchoolClient,
} from "@/lib/gradebook/powerschool";
import { activeCategories, defaultCategoryId } from "@/lib/gradebook/powerschoolPayloads";
import { log } from "@/lib/log";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The Send-to-gradebook dialog's category list (docs/gradebook-push-design.md,
 * slice 4 reads it): `?target=powerschool&section_ps_id=…`.
 *
 * Authorized exactly like the send (`authorizeSend`: `edit` on the assessment,
 * then the caller currently teaches the section; 404 otherwise), because the
 * list is read AS that teacher's `users_dcid`.
 *
 * Answers the ACTIVE categories, the D-6 default (the active district "Test"
 * copy, else null — the teacher must pick), and the remembered destination
 * for this (teacher, section) (D-5), or null.
 */
export async function GET(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const params = new URL(req.url).searchParams;
  const target = params.get("target");
  const sectionPsId = (params.get("section_ps_id") ?? "").trim();
  if ((target !== "powerschool" && target !== "schoology") || !sectionPsId || sectionPsId.length > 64) {
    return NextResponse.json({ ok: false, error: "invalid_query" }, { status: 400 });
  }

  const db = getDb();
  const access = await authorizeSend(db, auth.session, id, sectionPsId);
  if (!access.ok) return access.response;

  if (target !== "powerschool") {
    return NextResponse.json({ ok: false, error: "unsupported_target" }, { status: 400 });
  }

  const missing = missingPowerSchoolIds(access.teacher.users_dcid, access.section);
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, error: "missing_dcid", detail: { missing } }, { status: 409 });
  }

  let client;
  try {
    client = getPowerSchoolClient();
  } catch (err) {
    if (err instanceof GradebookConfigError) {
      log.error("gradebook_not_configured", { target: "powerschool" });
      return NextResponse.json({ ok: false, error: "gradebook_not_configured" }, { status: 503 });
    }
    throw err;
  }

  let all;
  try {
    all = await client.listCategories(access.teacher.users_dcid!, access.section.year_id!);
  } catch (err) {
    log.error("gradebook_push_failed", {
      target: "powerschool",
      stage: "categories",
      assessment_id: id,
      status: err instanceof GradebookHttpError ? err.status : undefined,
    });
    return NextResponse.json({ ok: false, error: "gradebook_unavailable" }, { status: 502 });
  }

  const [pref] = await db
    .select()
    .from(gradebook_section_prefs)
    .where(
      and(
        eq(gradebook_section_prefs.staff_sub, access.teacher.sub),
        eq(gradebook_section_prefs.section_ps_id, sectionPsId),
      ),
    )
    .limit(1);

  return NextResponse.json({
    ok: true,
    target: "powerschool",
    categories: activeCategories(all).map((c) => ({
      id: c.id,
      name: c.name,
      categorytype: c.categorytype,
      defaultpublishoption: c.defaultpublishoption,
    })),
    default_category_id: defaultCategoryId(all),
    remembered: pref ? { target: pref.target, category_id: pref.category_id } : null,
  });
}
