import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { getProvider } from "@/lib/ai/provider";
import { GenerateItemRequest } from "@/lib/ai/types";
import { CreateItemBody } from "@/lib/api/items";
import { runGuarded } from "@/lib/safeguarding/guard";
import { itemProposalText } from "@/lib/safeguarding/itemText";

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = GenerateItemRequest.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid_body";
    return NextResponse.json(
      { ok: false, error: "invalid_body", detail },
      { status: 400 },
    );
  }

  const db = getDb();
  const [assessmentRow] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, body.assessment_id))
    .limit(1);
  if (!assessmentRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (assessmentRow.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!assessmentRow.allow_llm_authoring) {
    return NextResponse.json(
      { ok: false, error: "llm_authoring_disabled" },
      { status: 403 },
    );
  }

  const provider = getProvider();

  // Safeguarding (slice 28): input + output guardrail checks wrap the
  // model call. With GUARDRAIL_PROVIDER=off (default) this is a direct
  // pass-through. A blocked input skips the model entirely.
  let outcome;
  try {
    outcome = await runGuarded({
      surface: "item-gen",
      ownerSub: auth.session.sub,
      inputText: body.prompt,
      run: () => provider.generateItem(body),
      outputText: (item) => itemProposalText(item),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "provider_failed";
    return NextResponse.json(
      { ok: false, error: "provider_failed", detail: message },
      { status: 502 },
    );
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
            ? "Your request was blocked by content safeguards. Edit the prompt and try again."
            : "The AI's draft was withheld by content safeguards. Try regenerating or rephrasing your prompt.",
      },
      { status: 422 },
    );
  }
  const proposal = outcome.result;

  // Double-validate against the CreateItemBody contract — guards against a
  // future provider returning a malformed shape and lets the editor save
  // the proposal through the existing POST /items route without surprises.
  const validated = CreateItemBody.safeParse(proposal);
  if (!validated.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "provider_returned_invalid_item",
        detail: validated.error.issues.slice(0, 5),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    provider: provider.id,
    proposal: validated.data,
  });
}
