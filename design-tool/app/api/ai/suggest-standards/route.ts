import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { getProvider } from "@/lib/ai/provider";
import { FRAMEWORK } from "@/lib/ai/itemBatchCore";
import {
  candidateScheme,
  loadCandidates,
  suggestionsText,
  toSuggestItems,
  validateSuggestions,
} from "@/lib/ai/standardsSuggestCore";
import {
  SUGGEST_MAX_ITEMS,
  SuggestStandardsRequest,
  type SuggestStandardsInput,
} from "@/lib/ai/types";
import { runGuarded } from "@/lib/safeguarding/guard";

// BG slice 5 (docs/batch-item-generation-design.md, D-2 / D-2a): "Suggest
// standards" for the assessment's UNTAGGED items. WRITES NOTHING — the
// suggestions come back for the teacher to accept one by one through the
// ordinary item save (an accepted tag is an ordinary tag; nothing records
// that it was suggested).
//
// One model call (1.3): the first 40 untagged items in item order; `left_out`
// says how many more there are, and after accepting they stop being untagged,
// so a second run covers the rest. The candidate set is the catalog slice for
// the required subject + grade band (1.4); a code outside it is dropped.

function invalid(detail: string) {
  return NextResponse.json({ ok: false, error: "invalid_body", detail }, { status: 400 });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return invalid("body is not JSON");
  }
  const parsed = SuggestStandardsRequest.safeParse(rawBody);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return invalid(detail);
  }
  const body = parsed.data;

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, body.assessment_id, "edit");
  if (!access.ok) return access.response;
  if (!access.assessment.allow_llm_authoring) {
    return NextResponse.json({ ok: false, error: "llm_authoring_disabled" }, { status: 403 });
  }

  const scheme = candidateScheme(body.subject, body.scheme);
  const candidates = loadCandidates({
    subject: body.subject,
    gradeBand: body.grade_band,
    ...(body.course ? { course: body.course } : {}),
    scheme,
    ...(body.unit_list ? { unitList: body.unit_list } : {}),
  });
  if (candidates.length === 0) {
    return invalid("no standards for that subject, grade band and course");
  }

  const rows = await db
    .select({ id: items.id, type: items.type, stem: items.stem, choices: items.choices, standards: items.standards })
    .from(items)
    .where(eq(items.assessment_id, body.assessment_id))
    .orderBy(asc(items.position));
  const untagged = rows.filter((r) => ((r.standards as string[] | null) ?? []).length === 0);
  const sent = toSuggestItems(untagged);
  const leftOut = Math.max(0, untagged.length - SUGGEST_MAX_ITEMS);

  const provider = getProvider();
  if (sent.length === 0) {
    return NextResponse.json({
      ok: true,
      suggestions: [],
      considered: 0,
      left_out: 0,
      provider: provider.id,
    });
  }

  const input: SuggestStandardsInput = {
    items: sent,
    candidates,
    framework: FRAMEWORK[scheme],
    ...(body.unit_list ? { unitList: body.unit_list } : {}),
  };

  // Guardrail (surface "tag-suggest", migration 0051). Input: the pasted unit
  // list — the one free text the teacher writes for this call (the questions
  // are already on the assessment; none is screened here, as the batch
  // generator's existing stems are not). Output: every kept reason.
  let outcome;
  try {
    outcome = await runGuarded({
      surface: "tag-suggest",
      ownerSub: auth.session.sub,
      ...(body.unit_list ? { inputText: body.unit_list } : {}),
      run: async () => {
        const raw = await provider.suggestStandards(input, auth.session.sub);
        return validateSuggestions(raw, { items: sent, candidates });
      },
      outputText: suggestionsText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "provider_failed";
    return NextResponse.json({ ok: false, error: "provider_failed", detail: message }, { status: 502 });
  }

  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "guardrail_blocked",
        stage: outcome.stage,
        findings: outcome.findings,
        note:
          outcome.stage === "input"
            ? "Your standards list was blocked by content safeguards. Edit it and try again."
            : "The AI's suggestions were withheld by content safeguards. Try again.",
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    suggestions: outcome.result.suggestions,
    considered: sent.length,
    left_out: leftOut,
    provider: provider.id,
  });
}
