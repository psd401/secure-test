import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { extractPdfText, looksScanned } from "@/lib/pdfImport/extractText";
import {
  extractPdfLayout,
  pageImagesWanted,
  renderPagesForModel,
  type PdfFigure,
} from "@/lib/pdfImport/extractFigures";
import { getPdfExtractorProvider } from "@/lib/pdfImport/provider";
import {
  MAX_OCR_BYTES,
  MAX_OCR_PAGES,
  PdfExtractError,
  adjacencyFallback,
  countNumberedItems,
  dropPrintCopies,
  fillBlankTableHeadings,
  flagShortenedSources,
  formsReport,
  keyFiguresFromText,
  numberingReport,
  proposalScreenText,
  readSourceNumbers,
  readCandidateChanges,
  validatePdfCandidates,
  validateProposedSets,
  withoutKeyFigures,
} from "@/lib/pdfImport/extractCore";
import { PdfExtractRequest, type PdfExtractResult } from "@/lib/pdfImport/types";
import { runGuarded, type GuardedOutcome } from "@/lib/safeguarding/guard";
import { requireDraft } from "@/lib/api/requireDraft";
import { requireStaff } from "@/lib/api/requireSession";
import { UUID_RE } from "@/lib/uuid";
import { authorizeAssessment } from "@/lib/api/access";

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
  if (err instanceof PdfExtractError && err.code === "refused") {
    return NextResponse.json(
      {
        ok: false,
        error: "pdf_extract_refused",
        hint:
          "The AI extractor declined to read this PDF. Trying again will not " +
          "change that; import the items by CSV or add them by hand.",
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
  const access = await authorizeAssessment(db, auth.session, id, "edit", "write");
  if (!access.ok) return access.response;
  const assessment = access.assessment;
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

  // PDF-import slice 3: the pages as images, so the model sees the layout.
  // On by default since slice 3c (James, 2026-10-25); PDF_IMPORT_PAGE_IMAGES=0
  // turns it off. A document over the page cap, or one that will not
  // render, goes as text alone.
  const pageImages = pageImagesWanted(scanned) ? await renderPagesForModel(bytes) : null;
  const reqBody = PdfExtractRequest.safeParse({
    text: modelText,
    page_count: extracted.pageCount,
    ...(scanned ? { scanned_pdf: bytes, file_name: file.name } : {}),
    ...(pageImages ? { page_images: pageImages } : {}),
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
    // 2026-10-25: the guardrail's PROMPT_ATTACK filter (HIGH / BLOCK) reads
    // ordinary test directions ("Answer all questions. Show your work.") as
    // injection, so an enforced input check refused real teacher PDFs. The
    // hit is recorded as "flag"; the output check below still blocks, the
    // prompt fences the text as data, and the teacher reviews every proposal.
    inputMode: "record",
    run: () => provider.extract(reqBody.data, auth.session.sub),
    // Every string the model proposed — stems, choices, pairs, blank
    // options and keys, answers, table labels, stimuli and sources. With
    // the input check record-only (above), this is the one enforced gate,
    // so it reads the whole proposal rather than stems alone (PR #108
    // review).
    outputText: (r) => proposalScreenText([r.candidates, r.proposed_sets ?? []]),
    });
  } catch (err) {
    return extractionFailure(err);
  }
  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "blocked_by_guardrail",
        stage: outcome.stage,
        // The panel shows `hint` in place of the code. The input check only
        // records on this surface, so it is the AI's proposed questions
        // that were stopped, not the teacher's PDF.
        hint: "The AI safety filter stopped the questions proposed from this PDF. Add these items by hand, or try importing a smaller part of the document.",
      },
      { status: 422 },
    );
  }

  // PDF-import fixes (2026-10-25): a form printed twice on one page comes
  // back twice; the repeat is dropped before anything else reads the list.
  const printCopies = dropPrintCopies(outcome.result.candidates, outcome.result.proposed_sets ?? []);
  // And a table's blank printed headings get a name (the write schema
  // refuses an empty label), reported on the card.
  const rawCandidates = fillBlankTableHeadings(printCopies.candidates);

  // E14: figures.length is 0 on every scan, which turns on the
  // `[FIGURE n]` strip — a marker there points at nothing.
  const { candidates, rejected, truncated } = validatePdfCandidates(
    rawCandidates,
    { figureCount: figures.length },
  );
  // E8 (2026-09-01): compare the document's own numbering with what came
  // back so a teacher learns which questions to author by hand. Scanned
  // PDFs have no text layer to count.
  // The list before print copies were dropped: a copy's printed numbers
  // were found, so they are not "missing".
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
  for (let i = 0; i < Math.min(rawCandidates.length, candidates.length + rejected.length); i++) {
    if (!rejectedIdx.has(i)) rawToValid.set(i, valid++);
  }
  const setValidation = validateProposedSets(printCopies.proposedSets, rawToValid, figures.length);
  const rawSourceNumbers = readSourceNumbers(rawCandidates);
  const validSourceNumbers = [...rawToValid.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([rawIndex]) => rawSourceNumbers[rawIndex] ?? []);
  // Beta feedback 2026-10-07: per validated candidate, what the model
  // changed from the printed text; the card flags it in blue.
  const rawChanges = readCandidateChanges(rawCandidates);
  const changes = [...rawToValid.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([rawIndex]) => rawChanges[rawIndex] ?? []);
  // Import fixes slice 2: the answer key's own drawings (a sample answer
  // under "Responses vary.") go in no set, so no student sees the answer.
  // A scan has no text to read the cue from (and no figures).
  const keyFigures = new Set(scanned ? [] : keyFiguresFromText(modelText));
  // And blank answer areas (an empty graph grid, a table to fill): where the
  // answer goes, never a picture above the question. And a drawing with two
  // prose lines inside (`text_inside`: an instructions box or a chart — the
  // import cannot tell): its text is already in the questions' text, so it
  // is not added as a picture unless the teacher chooses to.
  const neverShown = new Set([
    ...keyFigures,
    ...figures.filter((f) => f.answer_area || f.text_inside).map((f) => f.n),
  ]);
  const modelSets = withoutKeyFigures(setValidation.sets, neverShown);
  const proposed_sets = [
    ...modelSets,
    ...(scanned
      ? []
      : adjacencyFallback(
          figures.length,
          modelText,
          validSourceNumbers,
          modelSets,
          new Set(figures.filter((f) => f.beside).map((f) => f.n)),
          neverShown,
        )),
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
    // Aligned with `candidates`: [] for an item printed as is.
    changes,
    truncated,
    // Repeated questions (a form printed twice) left out of `candidates`.
    print_copies_dropped: printCopies.dropped,
    ...numbering,
    // E5 slice 4: every raster figure above MIN_FIGURE_PT, in document order,
    // with its page and (unless omitted for size) a PNG data URL.
    // Slice 2: `answer_key: true` on the key's own drawings; the panel
    // labels them and offers no way to put one with a question.
    figures: figures.map((f) => (keyFigures.has(f.n) ? { ...f, answer_key: true } : f)),
    figure_count: figures.length,
    // E5 slice 3: sets over validated candidate indexes; `source` says
    // whether the model paired them or the adjacency rule did.
    proposed_sets,
    rejected_sets: setValidation.rejected,
    // E9: null, or { count, groups (validated indexes per form) | null, source }.
    forms,
  });
}
