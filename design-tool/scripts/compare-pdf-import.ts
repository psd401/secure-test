// Slice 0 of the PDF-import fixes (2026-10-25): run the import extractor on
// one PDF with two or more Bedrock models and print what each proposed, so a
// model switch is decided on the same document, not on reputation.
//
//   bun scripts/compare-pdf-import.ts <file.pdf> \
//     [--model us.anthropic.claude-sonnet-4-6] [--model us.anthropic.claude-sonnet-5-5] [--runs 2] [--summary]
//
// A model given as <id>+images also sends the pages as images (slice 3);
// the suffixes combine (<id>@medium+images).
//
// A model given as <id>@<effort> (us.anthropic.claude-sonnet-5-5@medium) runs
// with BEDROCK_PDF_EXTRACT_EFFORT set to that level, so one call can compare
// effort levels on the same model.
//
// --expected <answers.json> scores each run against the hand-checked entry for
// this file name (scripts/pdfImportScore.ts); the answer set describes
// teacher documents, so it stays gitignored in samples/.
//
// --summary prints one JSON line per model run (counts, tokens, cost; no
// stems, no file name) for aggregating over many PDFs.
//
// Uses the caller's own AWS credentials (`aws sso login` first) and the same
// steps as the import route: text layer, figure markers, the extractor,
// validation, numbering and sets. The guardrail screen is skipped — this is a
// local measurement, nothing is saved. Stems are printed to the terminal only;
// never paste the output of a real teacher's PDF into a tracked file.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { scoreImport, type ExpectedImport } from "./pdfImportScore";
import { setLogSink } from "../lib/log";
import { extractPdfLayout, renderPagesForModel } from "../lib/pdfImport/extractFigures";
import { extractPdfText, looksScanned } from "../lib/pdfImport/extractText";
import {
  adjacencyFallback,
  countNumberedItems,
  dropPrintCopies,
  formsReport,
  keyFiguresFromText,
  withoutKeyFigures,
  numberingReport,
  readSourceNumbers,
  validatePdfCandidates,
  validateProposedSets,
} from "../lib/pdfImport/extractCore";
import { bedrockPdfExtractor } from "../lib/pdfImport/bedrockProvider";

const USAGE =
  "usage: bun scripts/compare-pdf-import.ts <file.pdf> [--model <bedrock id> …] [--runs n] [--summary] [--expected <answers.json>]";
const DEFAULT_MODELS = ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-5-5"];
// Bedrock us. on-demand $ per 1M tokens, in / out — same table as
// infra/scripts/ai-usage.sh (2026-10-03); a model missing here prints "?".
const PRICES: Record<string, [number, number]> = {
  "us.anthropic.claude-sonnet-4-6": [3.3, 16.5],
  "us.anthropic.claude-sonnet-5-5": [2.2, 11],
  "us.anthropic.claude-opus-5-5": [4.4, 22],
};

let file: string | undefined;
const models: string[] = [];
let runs = 1;
let summary = false;
let expectedPath: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "--model") {
    const v = argv[++i];
    if (!v) throw new Error("--model needs a Bedrock model id");
    models.push(v);
  } else if (arg === "--runs") {
    runs = Number(argv[++i]);
    if (!Number.isInteger(runs) || runs < 1 || runs > 5) {
      console.error("--runs must be 1–5");
      process.exit(2);
    }
  } else if (arg === "--expected") {
    expectedPath = argv[++i];
  } else if (arg === "--summary") {
    summary = true;
  } else if (!arg.startsWith("--") && !file) {
    file = arg;
  } else {
    console.error(`unknown argument "${arg}"\n${USAGE}`);
    process.exit(2);
  }
}
if (!file) {
  console.error(USAGE);
  process.exit(2);
}
if (models.length === 0) models.push(...DEFAULT_MODELS);
const expected = expectedPath
  ? ((JSON.parse(readFileSync(expectedPath, "utf8")) as Record<string, ExpectedImport>)[basename(file)] ?? null)
  : null;
if (expectedPath && !expected) {
  console.error(`no entry for "${basename(file)}" in ${expectedPath}`);
  process.exit(2);
}

// The extractor logs one ai_usage line per call; keep the last one for tokens.
let lastUsage: { input_tokens?: number; output_tokens?: number; latency_ms?: number } = {};
setLogSink((line) => {
  const parsed = JSON.parse(line) as { event?: string } & typeof lastUsage;
  if (parsed.event === "ai_usage") lastUsage = parsed;
});

const bytes = new Uint8Array(readFileSync(file));
const extracted = await extractPdfText(bytes);
if (looksScanned(extracted.text, extracted.pageCount)) {
  if (summary) console.log(JSON.stringify({ skipped: "scanned" }));
  else console.error("This PDF has no text layer; the comparison covers the text path only.");
  process.exit(summary ? 0 : 2);
}
const layout = await extractPdfLayout(bytes);
const text = layout.textWithMarkers.trim() ? layout.textWithMarkers : extracted.text;
const figureCount = layout.figures.length;
if (!summary) console.log(
  `${file}: ${extracted.pageCount} pages, ${figureCount} figures, ` +
    `${countNumberedItems(text)} numbered questions in the text\n`,
);

const short = (s: unknown, n = 70) => {
  const flat = String(s ?? "").replace(/\s+/g, " ");
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

let pageImages: Uint8Array<ArrayBuffer>[] | null | undefined;
for (const spec of models) {
  const withImages = spec.endsWith("+images");
  const [model, effort] = spec.replace(/\+images$/, "").split("@") as [string, string | undefined];
  if (withImages && pageImages === undefined) pageImages = await renderPagesForModel(bytes);
  for (let run = 1; run <= runs; run += 1) {
    process.env.BEDROCK_PDF_EXTRACT_MODEL = model;
    if (effort) process.env.BEDROCK_PDF_EXTRACT_EFFORT = effort;
    else delete process.env.BEDROCK_PDF_EXTRACT_EFFORT;
    lastUsage = {};
    const header = `== ${spec}${runs > 1 ? ` (run ${run})` : ""}`;
    let result;
    try {
      result = await bedrockPdfExtractor.extract({
        text,
        page_count: extracted.pageCount,
        ...(withImages && pageImages ? { page_images: pageImages } : {}),
      });
    } catch (err) {
      if (summary) {
        console.log(JSON.stringify({ model: spec, failed: err instanceof Error ? err.message.slice(0, 120) : "error" }));
        continue;
      }
      console.log(`${header}\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    // As the route: print copies out first; numbering reads the full list.
    const numbering = numberingReport(countNumberedItems(text), result.candidates);
    const printCopies = dropPrintCopies(result.candidates, result.proposed_sets ?? []);
    const raw = printCopies.candidates;
    const { candidates, rejected } = validatePdfCandidates(raw, { figureCount });
    const sourceNumbers = readSourceNumbers(raw);
    const rejectedIdx = new Set(rejected.map((r) => r.index));
    const rawToValid = new Map<number, number>();
    let valid = 0;
    raw.forEach((_, i) => {
      if (!rejectedIdx.has(i)) rawToValid.set(i, valid++);
    });
    const sets = validateProposedSets(printCopies.proposedSets, rawToValid, figureCount);
    // The route adds a set per unplaced figure (the adjacency rule); show both.
    const validSourceNumbers = [...rawToValid.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([rawIndex]) => sourceNumbers[rawIndex] ?? []);
    // As the route: the answer key's own drawings go in no set.
    const keyFigures = new Set(keyFiguresFromText(text));
    const modelSets = withoutKeyFigures(sets.sets, keyFigures);
    const allSets = [
      ...modelSets,
      ...adjacencyFallback(
        figureCount,
        text,
        validSourceNumbers,
        modelSets,
        new Set(layout.figures.filter((f) => f.beside).map((f) => f.n)),
        keyFigures,
      ),
    ];

    const price = PRICES[model];
    const inTok = lastUsage.input_tokens ?? 0;
    const outTok = lastUsage.output_tokens ?? 0;
    const cost = price ? `$${((inTok * price[0] + outTok * price[1]) / 1e6).toFixed(4)}` : "?";
    const checks = expected
      ? scoreImport(expected, {
          items: candidates.map((c, i) => {
            const cand = c as { type: string; correct_answer?: string | null };
            return { type: cand.type, numbers: validSourceNumbers[i] ?? [], correct_answer: cand.correct_answer };
          }),
          sets: allSets,
          key_figures: [...keyFigures],
          forms: (() => {
            const groups = formsReport(validSourceNumbers, text)?.groups;
            return groups
              ? { sizes: groups.map((g) => new Set(g.flatMap((i) => validSourceNumbers[i] ?? [])).size) }
              : null;
          })(),
        })
      : null;
    const failed = checks?.filter((c) => !c.pass) ?? [];
    if (summary) {
      const types: Record<string, number> = {};
      for (const c of raw) {
        const t = String((c as { type?: unknown }).type);
        types[t] = (types[t] ?? 0) + 1;
      }
      console.log(
        JSON.stringify({
          model: spec,
          pages: extracted.pageCount,
          numbered: numbering.numbered_items,
          valid: candidates.length,
          rejected: rejected.length,
          missing: numbering.missing_numbers?.length ?? null,
          model_sets: sets.sets.length,
          print_copies: printCopies.dropped,
          ...(checks
            ? {
                passed: checks.length - failed.length,
                checks: checks.length,
                failed: failed.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)),
              }
            : {}),
          figures: figureCount,
          in: inTok,
          out: outTok,
          cost_usd: price ? (inTok * price[0] + outTok * price[1]) / 1e6 : null,
          latency_ms: lastUsage.latency_ms ?? null,
          types,
        }),
      );
      continue;
    }
    console.log(header);
    if (checks) {
      console.log(`score ${checks.length - failed.length}/${checks.length}`);
      for (const c of failed) console.log(`  ✗ ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
    console.log(
      `tokens ${inTok} in / ${outTok} out · ${cost} · ${((lastUsage.latency_ms ?? 0) / 1000).toFixed(1)} s · ` +
        `${candidates.length} valid, ${rejected.length} rejected · missing numbers: ` +
        `${numbering.missing_numbers?.join(", ") || "none"}`,
    );
    raw.forEach((c, i) => {
      const cand = c as { type?: unknown; stem?: unknown; correct_choice_ids?: unknown };
      const nums = sourceNumbers[i]?.join(",") || "-";
      const flag = rejectedIdx.has(i) ? " [REJECTED]" : "";
      console.log(`  #${nums.padEnd(5)} ${String(cand.type).padEnd(24)} ${short(cand.stem)}${flag}`);
    });
    for (const s of allSets) {
      const qs = s.item_indexes.map((idx) => {
        const raw = [...rawToValid.entries()].find(([, v]) => v === idx)?.[0];
        return raw === undefined ? "?" : sourceNumbers[raw]?.join(",") || "-";
      });
      console.log(`  set (${s.source}): figures [${s.figures.join(", ")}] → questions ${qs.join(", ")}`);
    }
    if (keyFigures.size) console.log(`  answer-key figures: [${[...keyFigures].join(", ")}]`);
    if (sets.rejected.length) console.log(`  rejected sets: ${sets.rejected.length}`);
    console.log("");
  }
}
