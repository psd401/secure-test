import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { extractPdfText, looksScanned } from "@/lib/pdfImport/extractText";
import { extractPdfLayout, type PdfFigure } from "@/lib/pdfImport/extractFigures";
import { getPdfExtractorProvider } from "@/lib/pdfImport/provider";
import {
  MAX_OCR_BYTES,
  MAX_OCR_PAGES,
  PdfExtractError,
  adjacencyFallback,
  countNumberedItems,
  flagShortenedSources,
  formsReport,
  numberingReport,
  readSourceNumbers,
  validatePdfCandidates,
  validateProposedSets,
} from "@/lib/pdfImport/extractCore";
import { PdfExtractRequest, type PdfExtractResult } from "@/lib/pdfImport/types";
import { runGuarded, type GuardedOutcome } from "@/lib/safeguarding/guard";
import { requireDraft } from "@/lib/api/requireDraft";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// 2026-09-01 (ERAS exam, prod): a provider throw used to escape the handler
// as an empty-body 500, and the panel rendered the resulting JSON-parse
// TypeError. Every extraction failure now maps to a structured body with a
// teacher-facing hint; `detail` carries the underlying message for staff.
function extractionFailure(err: unknown) {
  if (err instanceof PdfExtractError && err.code === "truncated") {
    return NextResponse.json(
      {
        ok: false,
        error: "pdf_extract_truncated",
        hint:
          "This document has more items than one extraction can return. " +
          "Split the PDF into parts of about 6–8 pages and import each part.",
        detail: err.message,
      },
      { status: 422 },
    );
  }
  if (err instanceof PdfExtractError) {
    return NextResponse.json(
      {
        ok: false,
        error: "pdf_extract_invalid_output",
        hint:
          "The AI extractor did not return an item list for this PDF. Try " +
          "again; if it repeats, split the document or import the items by CSV.",
        detail: err.message,
      },
      { status: 422 },
    );
  }
  console.error("pdf-import: extraction failed", err);
  return NextResponse.json(
    {
      ok: false,
      error: "pdf_extract_failed",
      hint: "The AI extractor could not process this PDF right now. Try again in a minute.",
      detail: err instanceof Error ? err.message : String(err),
    },
    { status: 502 },
  );
}

// Text-layer PDFs are small teacher documents; 25 MiB is generous.
const MAX_BYTES = 25 * 1024 * 1024;

// Slice 42: extract candidate items from an uploaded text-layer PDF. This
// endpoint WRITES NOTHING — it returns proposals the teacher reviews and
// edits, then adds via the normal item-create path (propose-then-edit,
// like AI item gen). Slice 44 (ADR 0015): scanned/image PDFs are no longer
// rejected — the raw PDF rides to the provider as a Converse document
// block and the model reads the pages visually (capped at MAX_OCR_PAGES /
// MAX_OCR_BYTES). The extraction is guardrail-wrapped (surface
// "pdf-import"): extracted text checked before the model runs (skipped on
// the scanned branch, where no pre-model text exists), proposed stems
// after.
export async function POST(req: Request, ctx: RouteContext) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json(
      { ok: false, error: "expected_multipart" },
      { status: 400 },
    );
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
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", limit: MAX_BYTES },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let extracted;
  try {
    extracted = await extractPdfText(bytes);
  } catch {
    return NextResponse.json(
      { ok: false, error: "pdf_parse_failed" },
      { status: 400 },
    );
  }

  const scanned = looksScanned(extracted.text, extracted.pageCount);
  if (scanned) {
    if (extracted.pageCount > MAX_OCR_PAGES) {
      return NextResponse.json(
        {
          ok: false,
          error: "pdf_too_many_pages",
          limit: MAX_OCR_PAGES,
          hint:
            `Scanned PDFs are read by AI OCR, capped at ${MAX_OCR_PAGES} pages. ` +
            "Split the document or import in parts.",
        },
        { status: 422 },
      );
    }
    if (bytes.byteLength > MAX_OCR_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: "pdf_too_large_for_ocr",
          limit: MAX_OCR_BYTES,
          hint:
            "Scanned PDFs are limited to 10 MB for AI OCR. Reduce the scan " +
            "resolution or split the document.",
        },
        { status: 413 },
      );
    }
  }

  // E5 slice 4: on the text path the model reads the page text with a
  // `[FIGURE n]` marker where each raster figure sits, and the figures ride
  // the response as data URLs (assets only when the teacher adds a set —
  // extraction writes nothing). Scanned PDFs have no text layer to walk.
  let figures: PdfFigure[] = [];
  let modelText = extracted.text;
  if (!scanned) {
    try {
      const layout = await extractPdfLayout(bytes);
      figures = layout.figures;
      if (layout.textWithMarkers.trim().length > 0) modelText = layout.textWithMarkers;
    } catch (err) {
      // A figure walk that fails must not cost the teacher the import:
      // fall back to the flat text, no figures.
      console.warn("pdf-import: figure extraction failed", err instanceof Error ? err.message : err);
    }
  }

  const reqBody = PdfExtractRequest.safeParse({
    text: modelText,
    page_count: extracted.pageCount,
    ...(scanned ? { scanned_pdf: bytes, file_name: file.name } : {}),
  });
  if (!reqBody.success) {
    return NextResponse.json(
      { ok: false, error: "text_too_large_or_empty" },
      { status: 400 },
    );
  }

  const provider = getPdfExtractorProvider();
  let outcome: GuardedOutcome<PdfExtractResult>;
  try {
    outcome = await runGuarded({
    surface: "pdf-import",
    ownerSub: auth.session.sub,
    // Scanned branch: no pre-model text exists to screen, so the input
    // stage is skipped (ADR 0015); the output stage below still runs.
    ...(scanned ? {} : { inputText: reqBody.data.text }),
    run: () => provider.extract(reqBody.data, auth.session.sub),
    // E5 slice 3: proposed stimuli are model output too — same screen.
    outputText: (r) =>
      [
        ...r.candidates.map((c) =>
          c && typeof c === "object" && "stem" in c ? String((c as { stem: unknown }).stem) : "",
        ),
        ...(r.proposed_sets ?? []).flatMap((sset) => {
          if (!sset || typeof sset !== "object") return [""];
          const obj = sset as { stimulus?: unknown; sources?: unknown };
          // Multi-source stimulus slice 3: a source's text is model output
          // the student will read — the same screen as a stimulus.
          const sourceTexts = Array.isArray(obj.sources)
            ? obj.sources.map((s) =>
                s && typeof s === "object" && "text" in s
                  ? String((s as { text: unknown }).text)
                  : typeof s === "string"
                    ? s
                    : "",
              )
            : [];
          return ["stimulus" in obj ? String(obj.stimulus) : "", ...sourceTexts];
        }),
      ].join("\n"),
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

  // E14: figures.length is 0 on every scan, which turns on the
  // `[FIGURE n]` strip — a marker there points at nothing.
  const { candidates, rejected, truncated } = validatePdfCandidates(
    outcome.result.candidates,
    { figureCount: figures.length },
  );
  // E8 (2026-09-01): compare the document's own numbering with what came
  // back so a teacher learns which questions to author by hand. Scanned
  // PDFs have no text layer to count.
  const numbering = numberingReport(
    scanned ? null : countNumberedItems(modelText),
    outcome.result.candidates,
  );
  // E5 slice 3: the model's sets, remapped from raw to validated candidate
  // indexes (a rejected candidate just leaves its set), then the adjacency
  // rule for figures the model did not place — a set of one on the first
  // numbered question below the figure. The teacher confirms every pairing
  // in the panel before anything is written.
  const rejectedIdx = new Set(rejected.map((r) => r.index));
  const rawToValid = new Map<number, number>();
  let valid = 0;
  for (let i = 0; i < Math.min(outcome.result.candidates.length, candidates.length + rejected.length); i++) {
    if (!rejectedIdx.has(i)) rawToValid.set(i, valid++);
  }
  const setValidation = validateProposedSets(outcome.result.proposed_sets ?? [], rawToValid, figures.length);
  const rawSourceNumbers = readSourceNumbers(outcome.result.candidates);
  const validSourceNumbers = [...rawToValid.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([rawIndex]) => rawSourceNumbers[rawIndex] ?? []);
  const proposed_sets = [
    ...setValidation.sets,
    ...(scanned ? [] : adjacencyFallback(figures.length, modelText, validSourceNumbers, setValidation.sets)),
    // Multi-source stimulus slice 3: the model tends to abbreviate long
    // verbatim text, so compare each returned source with the document's own
    // span under the same heading. The scanned path has no text to compare.
  ].map((s) =>
    scanned || s.sources.length === 0
      ? s
      : { ...s, sources: flagShortenedSources(modelText, s.sources) },
  );
  // E9: several forms in one PDF, from the numbering restarting at 1 (any
  // path — the model reports printed numbers on a scan too) or, failing
  // that, "Form A / Form B" labels in the text layer.
  const forms = formsReport(validSourceNumbers, scanned ? null : modelText);

  return NextResponse.json({
    ok: true,
    page_count: extracted.pageCount,
    extracted_chars: extracted.text.length,
    ocr_used: scanned,
    candidates,
    // Review fix (2026-08-14): surface WHY candidates were rejected — a
    // keyless PDF rejects every MC/short_text candidate (the model is told
    // to omit answer keys it can't find, but items require them), and
    // without the per-candidate errors the teacher just saw "N skipped".
    rejected,
    rejected_count: rejected.length,
    truncated,
    ...numbering,
    // E5 slice 4: every raster figure above MIN_FIGURE_PT, in document order,
    // with its page and (unless omitted for size) a PNG data URL.
    figures,
    figure_count: figures.length,
    // E5 slice 3: sets over validated candidate indexes; `source` says
    // whether the model paired them or the adjacency rule did.
    proposed_sets,
    rejected_sets: setValidation.rejected,
    // E9: null, or { count, groups (validated indexes per form) | null, source }.
    forms,
  });
}
