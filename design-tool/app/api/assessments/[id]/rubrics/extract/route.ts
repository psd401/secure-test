import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import {
  RubricExtractError,
  normalizeRubric,
  rubricOutputText,
  type RubricWarning,
} from "@/lib/ai/rubricExtractor/extractCore";
import { getRubricExtractorProvider } from "@/lib/ai/rubricExtractor/provider";
import {
  MAX_RUBRIC_TEXT_CHARS,
  RubricExtractRequest,
  type RubricExtractResult,
} from "@/lib/ai/rubricExtractor/types";
import { requireDraft } from "@/lib/api/requireDraft";
import { requireStaff } from "@/lib/api/requireSession";
import { runGuarded, type GuardedOutcome } from "@/lib/safeguarding/guard";
import { UUID_RE } from "@/lib/uuid";
import type { ConverseDocumentFormat } from "@/lib/ai/bedrockConverse";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Rubric upload slice 1 (docs/rubric-upload-design.md, D-1/D-2): extract a
// rubric from an uploaded file or pasted text. This endpoint WRITES
// NOTHING — it returns a proposal the teacher reviews in the dialog and
// applies with the editor's own Save (propose-then-edit, exactly like the
// PDF importer). The extraction is guardrail-wrapped (surface
// "rubric-extract"): the text is screened before the model runs (skipped on
// the PDF / DOCX document path, where no pre-model text exists), the
// proposed criterion names + descriptors after.

/** A rubric is one to three pages; 25 MiB is the item importer's cap. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * D-1: PDF and DOCX ride to the model as Converse document blocks (the
 * table layout is what makes them readable); Markdown and plain text are
 * already structured, so they are decoded and sent as text — which also
 * lets the guardrail's input stage run on them.
 */
const ALLOWED: {
  ext: string;
  format: ConverseDocumentFormat;
  mimes: string[];
  as: "document" | "text";
}[] = [
  { ext: "pdf", format: "pdf", mimes: ["application/pdf"], as: "document" },
  {
    ext: "docx",
    format: "docx",
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    as: "document",
  },
  { ext: "md", format: "md", mimes: ["text/markdown", "text/x-markdown"], as: "text" },
  { ext: "txt", format: "txt", mimes: ["text/plain"], as: "text" },
];

function allowedFor(file: File): (typeof ALLOWED)[number] | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const byExt = ALLOWED.find((a) => a.ext === ext);
  if (byExt) return byExt;
  // A browser that sends no filename extension still sends a type.
  const mime = (file.type || "").split(";")[0]!.trim().toLowerCase();
  return ALLOWED.find((a) => a.mimes.includes(mime)) ?? null;
}

const TextBody = z.object({ text: z.string().min(1).max(MAX_RUBRIC_TEXT_CHARS) });

// Every extraction failure maps to a structured body with a teacher-facing
// hint; `detail` carries the underlying message for staff. Same shape and
// posture as the PDF importer's extractionFailure (2026-09-01).
function extractionFailure(err: unknown) {
  if (err instanceof RubricExtractError && err.code === "truncated") {
    return NextResponse.json(
      {
        ok: false,
        error: "rubric_extract_truncated",
        hint:
          "This rubric is longer than one extraction can return. Upload one " +
          "rubric at a time, or paste just the rubric table.",
        detail: err.message,
      },
      { status: 422 },
    );
  }
  if (err instanceof RubricExtractError) {
    return NextResponse.json(
      {
        ok: false,
        error: "rubric_extract_invalid_output",
        hint:
          "The AI could not read a rubric out of this. Check that the file " +
          "contains the rubric table, or paste the rubric as text and try again.",
        detail: err.message,
        ...(err.issues.length > 0 ? { issues: err.issues } : {}),
      },
      { status: 422 },
    );
  }
  console.error("rubric-extract: extraction failed", err);
  return NextResponse.json(
    {
      ok: false,
      error: "rubric_extract_failed",
      hint: "The AI extractor could not process this rubric right now. Try again in a minute.",
      detail: err instanceof Error ? err.message : String(err),
    },
    { status: 502 },
  );
}

export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!assessment) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (assessment.owner_sub !== auth.session.sub) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const draftGuard = requireDraft(assessment);
  if (draftGuard) return draftGuard;

  const ct = req.headers.get("content-type") ?? "";
  let extractReq: RubricExtractRequest;
  let source: { kind: "file" | "text"; bytes?: number; chars?: number; format?: string };

  if (ct.includes("multipart/form-data")) {
    let file: File;
    try {
      const form = await req.formData();
      const candidate = form.get("file");
      if (!(candidate instanceof File)) {
        return NextResponse.json({ ok: false, error: "missing_file" }, { status: 400 });
      }
      file = candidate;
    } catch {
      return NextResponse.json({ ok: false, error: "form_parse_failed" }, { status: 400 });
    }
    const allowed = allowedFor(file);
    if (!allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: "unsupported_type",
          hint:
            "Upload a PDF, a Word document (.docx), Markdown or a plain-text " +
            "file. A Google Doc can be downloaded as .docx or .pdf, or pasted.",
          allowed: ALLOWED.map((a) => a.ext),
        },
        { status: 415 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: "file_too_large", limit: MAX_BYTES },
        { status: 413 },
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = RubricExtractRequest.safeParse(
      allowed.as === "document"
        ? {
            document: { bytes, format: allowed.format, name: file.name },
            file_name: file.name,
          }
        : {
            // Markdown / plain text is already structured: decode it and take
            // the cheaper text path, which the guardrail can screen.
            text: new TextDecoder().decode(bytes).slice(0, MAX_RUBRIC_TEXT_CHARS),
            file_name: file.name,
          },
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "empty_file", hint: "This file has no readable rubric text." },
        { status: 400 },
      );
    }
    extractReq = parsed.data;
    source = { kind: "file", bytes: file.size, format: allowed.format };
  } else {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
    }
    const parsedBody = TextBody.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { ok: false, error: "invalid_body", limit: MAX_RUBRIC_TEXT_CHARS },
        { status: 400 },
      );
    }
    const parsed = RubricExtractRequest.safeParse({ text: parsedBody.data.text });
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
    extractReq = parsed.data;
    source = { kind: "text", chars: parsedBody.data.text.length };
  }

  const provider = getRubricExtractorProvider();
  let outcome: GuardedOutcome<{ rubric: unknown; warnings: RubricWarning[] }>;
  try {
    outcome = await runGuarded({
      surface: "rubric-extract",
      ownerSub: auth.session.sub,
      // Document path: no pre-model text exists to screen (the same rule
      // the scanned-PDF branch follows, ADR 0015); the output stage below
      // still runs.
      ...(extractReq.text !== undefined ? { inputText: extractReq.text } : {}),
      run: async () => {
        const result: RubricExtractResult = await provider.extract(extractReq);
        // Normalisation is inside the guarded call so a rubric that cannot
        // be made at all fails before anything is screened or returned.
        return normalizeRubric(result.rubric);
      },
      // What a student or family would eventually read: the criterion names
      // and the level descriptors.
      outputText: (r) => rubricOutputText(r.rubric),
    });
  } catch (err) {
    return extractionFailure(err);
  }
  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error: "blocked_by_guardrail", stage: outcome.stage },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    rubric: outcome.result.rubric,
    warnings: outcome.result.warnings,
    source,
  });
}
