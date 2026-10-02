import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/api/requireSession";
import {
  FACETS,
  SCHEMES,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SUBJECTS,
  resolveBareCode,
  searchStandards,
} from "@/lib/standards/search";
import type { StandardScheme, StandardSubject } from "@/lib/standards/types";

/**
 * BG slice 2 (docs/batch-item-generation-design.md §Standards tags): the
 * editor's standards picker. The catalog stays on the server — this route is
 * the only way a page reads it. Staff only; addresses no owned row.
 *
 * `?q=&subject=&grade_band=&scheme=&prefer=&course=&limit=` →
 * `{ results, exact, facets }`. `exact` is the tag a bare code resolves to
 * (exactly one scheme has that code), so Enter on typed text can store the
 * catalog tag instead of custom text.
 */
export async function GET(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const subject = param("subject");
  const scheme = param("scheme");
  const prefer = param("prefer");
  const limitRaw = param("limit");
  const limit = limitRaw === undefined ? SEARCH_LIMIT_DEFAULT : Number(limitRaw);
  if (
    (subject && !SUBJECTS.includes(subject as StandardSubject)) ||
    (scheme && !SCHEMES.includes(scheme as StandardScheme)) ||
    (prefer && !SCHEMES.includes(prefer as StandardScheme)) ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    return NextResponse.json({ ok: false, error: "invalid_query" }, { status: 400 });
  }
  const q = url.searchParams.get("q") ?? "";
  const results = searchStandards({
    q,
    subject: subject as StandardSubject | undefined,
    gradeBand: param("grade_band"),
    scheme: scheme as StandardScheme | undefined,
    prefer: prefer as StandardScheme | undefined,
    course: param("course"),
    limit: Math.min(limit, SEARCH_LIMIT_MAX),
  });
  return NextResponse.json({
    results,
    exact: q.trim() ? resolveBareCode(q) : null,
    facets: FACETS,
  });
}
