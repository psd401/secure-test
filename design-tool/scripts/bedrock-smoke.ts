// Manual live validation of the Amazon Bedrock providers (AWS SDK Converse +
// SigV4). NOT run in CI: it makes real, paid Bedrock calls. It needs AWS
// credentials + region resolvable from the environment (an AWS profile, access
// keys, or SSO) with `bedrock:InvokeModel` on the Sonnet 4.6 / Haiku 4.5 `us.`
// inference-profile ARNs. bun auto-loads design-tool/.env.local, so any keys
// there stay off the command line.
//
//   cd design-tool && bun scripts/bedrock-smoke.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { converseText } from "../lib/ai/bedrockConverse";
import { bedrockPdfExtractor } from "../lib/pdfImport/bedrockProvider";
import { validatePdfCandidates } from "../lib/pdfImport/extractCore";
import { extractPdfText, looksScanned } from "../lib/pdfImport/extractText";
import { bedrockItemProvider } from "../lib/ai/bedrockProvider";
import { bedrockMathTranslator } from "../lib/ai/mathTranslator/bedrockProvider";
import { getProvider } from "../lib/ai/provider";
import { getMathTranslatorProvider } from "../lib/ai/mathTranslator/provider";

// Minimal single-page PDF with a text layer (same construction as
// test/pdf-import-route.test.ts makeTextPdf). Enough to prove the Converse
// document-block transport end to end; OCR quality on a real scan is the
// slice-45 validation, not this probe's job.
function makeSmokePdf(lines: string[]): Uint8Array {
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT /F1 12 Tf 72 720 Td";
  lines.forEach((line, i) => {
    if (i > 0) content += " 0 -16 Td";
    content += ` (${esc(line)}) Tj`;
  });
  content += " ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function presence(v: string | undefined): string {
  return v ? `set (length ${v.length})` : "MISSING";
}

async function section(name: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

console.log("=== config sanity (no secrets printed) ===");
console.log("AI_PROVIDER             :", process.env.AI_PROVIDER ?? "(unset → mock)");
console.log(
  "MATH_TRANSLATOR_PROVIDER:",
  process.env.MATH_TRANSLATOR_PROVIDER ?? "(unset → mock)",
);
console.log("AWS_REGION              :", process.env.AWS_REGION ?? "(unset → us-west-2 default)");
console.log("AWS_PROFILE             :", process.env.AWS_PROFILE ?? "(unset)");
console.log("AWS_ACCESS_KEY_ID       :", presence(process.env.AWS_ACCESS_KEY_ID));
console.log("resolved item provider  :", getProvider().id);
console.log("resolved math provider  :", getMathTranslatorProvider().id);

const results: Record<string, boolean> = {};

results.item = await section("item gen — Sonnet 4.6 via Converse tool-use", async () => {
  const item = await bedrockItemProvider.generateItem({
    assessment_id: "00000000-0000-0000-0000-000000000001",
    item_type: "multiple_choice_single",
    prompt:
      "A 5th-grade question about adding two fractions with unlike denominators, with one plausible distractor per common misconception.",
  });
  console.log(JSON.stringify(item, null, 2));
});

results.math = await section("math translate — Haiku 4.5 via Converse", async () => {
  const out = await bedrockMathTranslator.translate({
    prompt: "plus or minus the square root of b squared minus 4ac, all over 2a",
    display_mode: "inline",
  });
  console.log("latex:", out.latex);
});

results.document = await section(
  "document block — PDF attached via converseText (ADR 0015)",
  async () => {
    const pdf = makeSmokePdf([
      "The capital of Washington State is Olympia.",
      "It has been the capital since statehood in 1889.",
    ]);
    const answer = await converseText({
      modelId: process.env.BEDROCK_PDF_EXTRACT_MODEL ?? "us.anthropic.claude-sonnet-4-6",
      systemText:
        "Answer using only the attached document. Reply with the answer text only.",
      userText: "According to the document, what is the capital of Washington State?",
      maxTokens: 64,
      temperature: 0,
      // Name deliberately includes chars Bedrock rejects, to exercise the
      // wrapper's sanitizer against the live validator.
      document: { bytes: pdf, name: "smoke_probe.v1.pdf" },
      errPrefix: "bedrock_smoke",
    });
    console.log("answer:", answer.trim());
    if (!/olympia/i.test(answer)) {
      throw new Error("model did not answer from the attached document");
    }
  },
);

results.ocr = await section(
  "scanned-PDF OCR — image-only fixture via bedrockPdfExtractor (slice 45)",
  async () => {
    const bytes = new Uint8Array(
      readFileSync(resolve(import.meta.dir, "../test/fixtures/scanned-test.pdf")),
    );
    const ex = await extractPdfText(bytes);
    if (!looksScanned(ex.text, ex.pageCount)) {
      throw new Error("fixture unexpectedly has a text layer");
    }
    const t0 = performance.now();
    const { candidates } = await bedrockPdfExtractor.extract({
      text: "",
      page_count: ex.pageCount,
      scanned_pdf: bytes,
      file_name: "scanned-test.pdf",
    });
    const v = validatePdfCandidates(candidates);
    console.log(
      `pages: ${ex.pageCount} · latency: ${Math.round(performance.now() - t0)}ms · ` +
        `valid: ${v.candidates.length} · rejected: ${v.rejected.length}`,
    );
    console.log("types:", v.candidates.map((c) => c.type).join(", "));
    if (v.candidates.length < 3) {
      throw new Error("expected at least 3 items from the scanned fixture");
    }
  },
);

results.usage = await section("raw usage probe — Converse usage block", async () => {
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "us-west-2",
  });
  const r = await client.send(
    new ConverseCommand({
      modelId: process.env.BEDROCK_ITEM_MODEL ?? "us.anthropic.claude-sonnet-4-6",
      system: [{ text: "You are a concise assistant." }],
      messages: [{ role: "user", content: [{ text: "Say hello in three words." }] }],
      inferenceConfig: { maxTokens: 32 },
    }),
  );
  console.log("usage:", JSON.stringify(r.usage));
});

console.log("\n=== summary ===");
for (const [k, ok] of Object.entries(results)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${k}`);
}
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
