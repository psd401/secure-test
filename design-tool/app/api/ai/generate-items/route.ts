import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { items } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { authorizeAssessment } from "@/lib/api/access";
import { getProvider } from "@/lib/ai/provider";
import {
  ALLOWED_UPLOADS,
  MAX_UPLOAD_BYTES,
  allowedUploadFor,
} from "@/lib/ai/documentUpload";
import {
  EXISTING_STEMS_MAX,
  capExistingStems,
  resolveTargetStandards,
  validateBatchProposals,
} from "@/lib/ai/itemBatchCore";
import {
  GenerateItemsRequest,
  MAX_BATCH_RESOURCE_CHARS,
  hasBatchFocus,
  type BatchGenerateInput,
} from "@/lib/ai/types";
import type { CreateItemBody } from "@/lib/api/items";
import { runGuarded } from "@/lib/safeguarding/guard";
import { itemProposalText } from "@/lib/safeguarding/itemText";

// BG slice 3 (docs/batch-item-generation-design.md, D-3 … D-7): up to ten AI
// item proposals in one call, tied to standards / an objective / a resource.
// WRITES NOTHING — the proposals come back unsaved and the teacher adds them
// through the existing items route (same as the single-item generator).
//
// Two request shapes: JSON (`resource: { text }` for pasted source material),
// or multipart with the same JSON in the `request` field and a PDF / DOCX /
// Markdown / text `file` — the rubric upload's types and size cap (D-4).

function invalid(detail: string) {
  return NextResponse.json({ ok: false, error: "invalid_body", detail }, { status: 400 });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  let rawBody: unknown;
  let file: File | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const request = form.get("request");
      if (typeof request !== "string") return invalid("missing request field");
      rawBody = JSON.parse(request);
      const candidate = form.get("file");
      if (candidate instanceof File) file = candidate;
    } catch {
      return NextResponse.json({ ok: false, error: "form_parse_failed" }, { status: 400 });
    }
  } else {
    try {
      rawBody = await req.json();
    } catch {
      return invalid("body is not JSON");
    }
  }

  const parsed = GenerateItemsRequest.safeParse(rawBody);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return invalid(detail);
  }
  const body = parsed.data;
  if (file && body.resource) return invalid("send a file or resource.text, not both");
  if (!hasBatchFocus(body, file !== null)) {
    return invalid("give at least one of target (standards / objective), resource or notes");
  }

  // The file's type and size are checked before any DB work, like the rubric upload.
  let resource: BatchGenerateInput["resource"];
  if (file) {
    const allowed = allowedUploadFor(file);
    if (!allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: "unsupported_type",
          hint:
            "Upload a PDF, a Word document (.docx), Markdown or a plain-text " +
            "file. A Google Doc can be downloaded as .docx or .pdf, or pasted.",
          allowed: ALLOWED_UPLOADS.map((a) => a.ext),
        },
        { status: 415 },
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: "file_too_large", limit: MAX_UPLOAD_BYTES },
        { status: 413 },
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (allowed.as === "document") {
      resource = { document: { bytes, format: allowed.format, name: file.name } };
    } else {
      // Markdown / plain text: decoded and sent as text, which the guardrail can screen.
      const text = new TextDecoder().decode(bytes).trim().slice(0, MAX_BATCH_RESOURCE_CHARS);
      if (!text) return invalid("the file has no readable text");
      resource = { text };
    }
  } else if (body.resource) {
    resource = { text: body.resource.text };
  }

  const db = getDb();
  const access = await authorizeAssessment(db, auth.session, body.assessment_id, "edit");
  if (!access.ok) return access.response;
  if (!access.assessment.allow_llm_authoring) {
    return NextResponse.json(
      { ok: false, error: "llm_authoring_disabled" },
      { status: 403 },
    );
  }

  // "Do not duplicate these": the assessment's own stems, in order, capped.
  const stemRows = await db
    .select({ stem: items.stem })
    .from(items)
    .where(eq(items.assessment_id, body.assessment_id))
    .orderBy(asc(items.position))
    .limit(EXISTING_STEMS_MAX);

  const standards = body.target?.standards ?? [];
  const input: BatchGenerateInput = {
    count: body.count,
    types: body.types,
    standards: resolveTargetStandards(standards),
    ...(body.target?.objective ? { objective: body.target.objective } : {}),
    difficulty: body.difficulty,
    ...(body.notes ? { notes: body.notes } : {}),
    ...(resource ? { resource } : {}),
    existingStems: capExistingStems(stemRows.map((r) => r.stem)),
  };

  // Guardrail (surface "item-gen" — guardrail_events.surface is pinned by a
  // CHECK constraint, and this is the same authoring surface). Input: the
  // teacher's own text — notes, objective, pasted / decoded resource text; a
  // PDF / DOCX has no pre-model text (the rubric upload's rule). Output: every
  // kept proposal, so a dropped element is never screened or returned.
  const inputText = [
    input.notes,
    input.objective,
    input.resource && "text" in input.resource ? input.resource.text : undefined,
  ]
    .filter((t): t is string => !!t)
    .join("\n\n");

  const provider = getProvider();
  let outcome;
  try {
    outcome = await runGuarded({
      surface: "item-gen",
      ownerSub: auth.session.sub,
      ...(inputText ? { inputText } : {}),
      run: async () => {
        const raw = await provider.generateItems(input, auth.session.sub);
        const batch = validateBatchProposals(raw, {
          count: body.count,
          types: body.types,
          standards,
        });
        if (batch.proposals.length === 0) {
          throw new Error(
            `provider_returned_no_valid_items: ${raw.length} returned` +
              (batch.issues.length > 0 ? `; ${batch.issues.join("; ")}` : ""),
          );
        }
        return batch;
      },
      outputText: (batch) =>
        batch.proposals.map((p: CreateItemBody) => itemProposalText(p)).join("\n\n"),
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
            ? "Your request was blocked by content safeguards. Edit the notes, objective or source material and try again."
            : "The AI's drafts were withheld by content safeguards. Try generating again or rephrasing your request.",
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    proposals: outcome.result.proposals,
    requested: body.count,
    dropped: outcome.result.dropped,
    provider: provider.id,
  });
}
