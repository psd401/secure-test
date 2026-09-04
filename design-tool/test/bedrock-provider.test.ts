// Bedrock providers (AWS SDK Converse + SigV4, ADRs 0007/0011). The
// `@aws-sdk/client-bedrock-runtime` module is mocked at module level so no AWS
// credentials / network access are required: a fake ConverseCommand captures
// its input and a fake BedrockRuntimeClient.send returns a staged Converse
// response. Tests focus on the Bedrock-specific seams — the `us.` inference
// profile default ids, the forced emit_item tool, the tolerant normalizer, the
// LaTeX strip, error wrapping, and the env selectors.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

interface ConverseResponse {
  output?: {
    message?: {
      content?: Array<{ text?: string; toolUse?: { name?: string; input?: unknown } }>;
    };
  };
  usage?: unknown;
  // ApplyGuardrail responses share this fake client + resolver (slice 29).
  action?: "NONE" | "GUARDRAIL_INTERVENED";
  assessments?: unknown[];
}
type Resolver =
  | { kind: "ok"; response: ConverseResponse }
  | { kind: "throw"; error: Error };

let nextResolver: Resolver | null = null;
const callLog: {
  modelId: string;
  system: unknown;
  messages: unknown;
  toolConfig: unknown;
  // Raw command input — guardrail tests read guardrailIdentifier/source/etc.
  input: Record<string, unknown>;
}[] = [];

function setNextResponse(response: ConverseResponse) {
  nextResolver = { kind: "ok", response };
}
function setNextError(error: Error) {
  nextResolver = { kind: "throw", error };
}

class FakeAwsError extends Error {
  $metadata: { httpStatusCode: number };
  constructor(name: string, httpStatusCode: number, message: string) {
    super(message);
    this.name = name;
    this.$metadata = { httpStatusCode };
  }
}

class FakeConverseCommand {
  constructor(public input: Record<string, unknown>) {}
}
class FakeApplyGuardrailCommand {
  constructor(public input: Record<string, unknown>) {}
}

class FakeBedrockRuntimeClient {
  constructor(_config?: unknown) {}
  async send(command: { input: Record<string, unknown> }) {
    callLog.push({
      modelId: command.input.modelId as string,
      system: command.input.system,
      messages: command.input.messages,
      toolConfig: command.input.toolConfig,
      input: command.input,
    });
    if (!nextResolver) throw new Error("test forgot to stage a response");
    const r = nextResolver;
    nextResolver = null;
    if (r.kind === "throw") throw r.error;
    return r.response;
  }
}

mock.module("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: FakeBedrockRuntimeClient,
  ConverseCommand: FakeConverseCommand,
  ApplyGuardrailCommand: FakeApplyGuardrailCommand,
}));

const itemResponse = (input: unknown): ConverseResponse => ({
  output: { message: { content: [{ toolUse: { name: "emit_item", input } }] } },
});
const textResponse = (text: string): ConverseResponse => ({
  output: { message: { content: [{ text }] } },
});

let originalProvider: string | undefined;
let originalItemModel: string | undefined;
let originalRegion: string | undefined;
let originalMathProvider: string | undefined;
let originalMathModel: string | undefined;
let originalGuardrailId: string | undefined;
let originalGuardrailVersion: string | undefined;
let originalGuardrailProvider: string | undefined;

beforeAll(() => {
  originalProvider = process.env.AI_PROVIDER;
  originalItemModel = process.env.BEDROCK_ITEM_MODEL;
  originalRegion = process.env.AWS_REGION;
  originalMathProvider = process.env.MATH_TRANSLATOR_PROVIDER;
  originalMathModel = process.env.BEDROCK_MATH_MODEL;
  originalGuardrailId = process.env.GUARDRAIL_ID;
  originalGuardrailVersion = process.env.GUARDRAIL_VERSION;
  originalGuardrailProvider = process.env.GUARDRAIL_PROVIDER;
});

afterAll(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("AI_PROVIDER", originalProvider);
  restore("BEDROCK_ITEM_MODEL", originalItemModel);
  restore("AWS_REGION", originalRegion);
  restore("MATH_TRANSLATOR_PROVIDER", originalMathProvider);
  restore("BEDROCK_MATH_MODEL", originalMathModel);
  restore("GUARDRAIL_ID", originalGuardrailId);
  restore("GUARDRAIL_VERSION", originalGuardrailVersion);
  restore("GUARDRAIL_PROVIDER", originalGuardrailProvider);
});

beforeEach(() => {
  nextResolver = null;
  callLog.length = 0;
  process.env.GUARDRAIL_ID = "gr-test-123";
});

afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.BEDROCK_ITEM_MODEL;
  delete process.env.MATH_TRANSLATOR_PROVIDER;
  delete process.env.BEDROCK_MATH_MODEL;
  delete process.env.GUARDRAIL_ID;
  delete process.env.GUARDRAIL_VERSION;
  delete process.env.GUARDRAIL_PROVIDER;
});

describe("bedrockItemProvider (Converse + tool use)", () => {
  test("defaults to the us. Sonnet 4.6 profile and forces the emit_item tool", async () => {
    setNextResponse(
      itemResponse({
        type: "multiple_choice_single",
        stem: "What is 2 + 2?",
        choices: [
          { id: "a", text: "3" },
          { id: "b", text: "4" },
          { id: "c", text: "5" },
          { id: "d", text: "22" },
        ],
        correct_choice_ids: ["b"],
      }),
    );
    const { bedrockItemProvider } = await import("../lib/ai/bedrockProvider");
    const out = await bedrockItemProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000001",
      item_type: "multiple_choice_single",
      prompt: "ask about 2 + 2",
    });
    expect(callLog.length).toBe(1);
    expect(callLog[0]!.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    expect(callLog[0]!.toolConfig).toMatchObject({
      toolChoice: { tool: { name: "emit_item" } },
    });
    expect(out.type).toBe("multiple_choice_single");
    if (out.type === "multiple_choice_single") {
      expect(out.correct_choice_ids).toEqual(["b"]);
      expect(out.choices.length).toBe(4);
      expect(out.correct_answer).toBeNull();
    }
  });

  test("normalizes a short_text item (string correct_answer, empty choices)", async () => {
    setNextResponse(
      itemResponse({
        type: "short_text",
        stem: "Capital of WA?",
        choices: [],
        correct_choice_ids: [],
        correct_answer: "Olympia",
      }),
    );
    const { bedrockItemProvider } = await import("../lib/ai/bedrockProvider");
    const out = await bedrockItemProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000001",
      item_type: "short_text",
      prompt: "capital of WA",
    });
    expect(out.type).toBe("short_text");
    if (out.type === "short_text") {
      expect(out.correct_answer).toBe("Olympia");
      expect(out.choices).toEqual([]);
    }
  });

  test("tolerates a stringified choices array from the model", async () => {
    setNextResponse(
      itemResponse({
        type: "multiple_choice_single",
        stem: "Q",
        // Claude sometimes serializes a nested array as a JSON string.
        choices: JSON.stringify([
          { id: "a", text: "x" },
          { id: "b", text: "y" },
        ]),
        correct_choice_ids: ["a"],
      }),
    );
    const { bedrockItemProvider } = await import("../lib/ai/bedrockProvider");
    const out = await bedrockItemProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000001",
      item_type: "multiple_choice_single",
      prompt: "Q",
    });
    if (out.type === "multiple_choice_single") {
      expect(out.choices).toEqual([
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ]);
    }
  });

  test("honors BEDROCK_ITEM_MODEL override + id reflects it", async () => {
    process.env.BEDROCK_ITEM_MODEL = "us.anthropic.claude-opus-4-8";
    setNextResponse(
      itemResponse({
        type: "short_text",
        stem: "Q",
        choices: [],
        correct_choice_ids: [],
        correct_answer: "A",
      }),
    );
    const { bedrockItemProvider } = await import("../lib/ai/bedrockProvider");
    expect(bedrockItemProvider.id).toBe("bedrock-us.anthropic.claude-opus-4-8");
    await bedrockItemProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000001",
      item_type: "short_text",
      prompt: "Q",
    });
    expect(callLog[0]!.modelId).toBe("us.anthropic.claude-opus-4-8");
  });

  test("throws bedrock_returned_no_tool_use when the model emits no tool call", async () => {
    setNextResponse(textResponse("I cannot do that."));
    const { bedrockItemProvider } = await import("../lib/ai/bedrockProvider");
    await expect(
      bedrockItemProvider.generateItem({
        assessment_id: "00000000-0000-0000-0000-000000000001",
        item_type: "short_text",
        prompt: "Q",
      }),
    ).rejects.toThrow(/bedrock_returned_no_tool_use/);
  });

  test("wraps an AWS service error as bedrock_api_error_<status>", async () => {
    setNextError(new FakeAwsError("AccessDeniedException", 403, "not authorized"));
    const { bedrockItemProvider } = await import("../lib/ai/bedrockProvider");
    await expect(
      bedrockItemProvider.generateItem({
        assessment_id: "00000000-0000-0000-0000-000000000001",
        item_type: "short_text",
        prompt: "Q",
      }),
    ).rejects.toThrow(/bedrock_api_error_403/);
  });
});

describe("bedrockMathTranslator (Converse text)", () => {
  test("defaults to the us. Haiku 4.5 profile and returns LaTeX", async () => {
    setNextResponse(textResponse("\\frac{1}{2}+\\frac{1}{3}"));
    const { bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/bedrockProvider"
    );
    const out = await bedrockMathTranslator.translate({
      prompt: "one half plus one third",
      display_mode: "inline",
    });
    expect(callLog.length).toBe(1);
    expect(callLog[0]!.modelId).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(out.latex).toBe("\\frac{1}{2}+\\frac{1}{3}");
  });

  test("strips outer $...$ wrappers if the model adds them", async () => {
    setNextResponse(textResponse("$x^2 + 1$"));
    const { bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/bedrockProvider"
    );
    const out = await bedrockMathTranslator.translate({
      prompt: "x squared plus one",
      display_mode: "inline",
    });
    expect(out.latex).toBe("x^2 + 1");
  });

  test("strips ```latex fences if the model wraps the response", async () => {
    setNextResponse(textResponse("```latex\n\\sqrt{2}\n```"));
    const { bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/bedrockProvider"
    );
    const out = await bedrockMathTranslator.translate({
      prompt: "square root of two",
      display_mode: "inline",
    });
    expect(out.latex).toBe("\\sqrt{2}");
  });

  test("rejects empty model output", async () => {
    setNextResponse(textResponse("   "));
    const { bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/bedrockProvider"
    );
    await expect(
      bedrockMathTranslator.translate({ prompt: "Q", display_mode: "inline" }),
    ).rejects.toThrow(/bedrock_returned_empty_latex/);
  });

  test("honors BEDROCK_MATH_MODEL override + id reflects it", async () => {
    process.env.BEDROCK_MATH_MODEL = "us.anthropic.claude-sonnet-4-6";
    setNextResponse(textResponse("x"));
    const { bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/bedrockProvider"
    );
    expect(bedrockMathTranslator.id).toBe("bedrock-us.anthropic.claude-sonnet-4-6");
    await bedrockMathTranslator.translate({ prompt: "x", display_mode: "inline" });
    expect(callLog[0]!.modelId).toBe("us.anthropic.claude-sonnet-4-6");
  });

  test("wraps an AWS service error as bedrock_api_error_<status>", async () => {
    setNextError(new FakeAwsError("ThrottlingException", 429, "slow down"));
    const { bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/bedrockProvider"
    );
    await expect(
      bedrockMathTranslator.translate({ prompt: "Q", display_mode: "inline" }),
    ).rejects.toThrow(/bedrock_api_error_429/);
  });
});

// Slice 45 (ADR 0015): the PDF extractor's two request shapes. First unit
// coverage for bedrockPdfExtractor — the live path is scripts/bedrock-smoke.ts.
describe("bedrockPdfExtractor (text path vs scanned/document path)", () => {
  test("text path: extracted-text prompt, single text block, parses JSON array", async () => {
    setNextResponse(textResponse('[{"type":"essay","stem":"Q"}]'));
    const { bedrockPdfExtractor } = await import("../lib/pdfImport/bedrockProvider");
    const out = await bedrockPdfExtractor.extract({
      text: "Some extracted test text",
      page_count: 1,
    });
    expect(out.candidates).toEqual([{ type: "essay", stem: "Q" }]);
    expect(callLog[0]!.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    const msg = callLog[0]!.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(msg[0]!.content).toHaveLength(1);
    expect(String(msg[0]!.content[0]!.text)).toContain("TEST DOCUMENT TEXT");
    expect(String(msg[0]!.content[0]!.text)).toContain("Some extracted test text");
  });

  test("scanned path: document block + OCR prompt, tolerates fenced JSON", async () => {
    setNextResponse(textResponse("```json\n[]\n```"));
    const { bedrockPdfExtractor } = await import("../lib/pdfImport/bedrockProvider");
    const bytes = new TextEncoder().encode("%PDF fake scan");
    const out = await bedrockPdfExtractor.extract({
      text: "",
      page_count: 2,
      scanned_pdf: bytes,
      file_name: "scan_v1.pdf",
    });
    expect(out.candidates).toEqual([]);
    const msg = callLog[0]!.messages as Array<{
      content: Array<{ document?: { format: string; name: string; source: { bytes: Uint8Array } }; text?: string }>;
    }>;
    expect(msg[0]!.content).toHaveLength(2);
    expect(msg[0]!.content[0]!.document).toMatchObject({
      format: "pdf",
      name: "scan v1 pdf", // sanitized by the wrapper
    });
    expect(msg[0]!.content[0]!.document!.source.bytes).toEqual(bytes);
    expect(msg[0]!.content[1]!.text).toContain("scanned images");
  });

  test("honors BEDROCK_PDF_EXTRACT_MODEL override + id reflects it", async () => {
    process.env.BEDROCK_PDF_EXTRACT_MODEL = "us.anthropic.claude-opus-4-8";
    setNextResponse(textResponse("[]"));
    const { bedrockPdfExtractor } = await import("../lib/pdfImport/bedrockProvider");
    expect(bedrockPdfExtractor.id).toBe("bedrock-us.anthropic.claude-opus-4-8");
    await bedrockPdfExtractor.extract({ text: "T", page_count: 1 });
    expect(callLog[0]!.modelId).toBe("us.anthropic.claude-opus-4-8");
    delete process.env.BEDROCK_PDF_EXTRACT_MODEL;
  });

  test("non-JSON model output throws with the bedrock prefix", async () => {
    setNextResponse(textResponse("I found three questions in the document."));
    const { bedrockPdfExtractor } = await import("../lib/pdfImport/bedrockProvider");
    await expect(
      bedrockPdfExtractor.extract({ text: "T", page_count: 1 }),
    ).rejects.toThrow(/valid JSON/);
  });
});

// Slice 43 (ADR 0015): document-block plumbing on converseText. Request
// construction only — the live transport is validated by scripts/bedrock-smoke.ts.
describe("converseText document block (ADR 0015)", () => {
  const baseOpts = {
    modelId: "us.anthropic.claude-sonnet-4-6",
    systemText: "sys",
    userText: "hello",
    maxTokens: 16,
    errPrefix: "bedrock",
  };

  test("no document → single text content block (existing shape unchanged)", async () => {
    setNextResponse(textResponse("ok"));
    const { converseText } = await import("../lib/ai/bedrockConverse");
    const out = await converseText(baseOpts);
    expect(out).toBe("ok");
    expect(callLog[0]!.messages).toEqual([
      { role: "user", content: [{ text: "hello" }] },
    ]);
  });

  test("document present → pdf document block precedes the text block", async () => {
    setNextResponse(textResponse("extracted"));
    const { converseText } = await import("../lib/ai/bedrockConverse");
    const bytes = new TextEncoder().encode("%PDF-1.4 fake");
    await converseText({ ...baseOpts, document: { bytes, name: "scan" } });
    expect(callLog[0]!.messages).toEqual([
      {
        role: "user",
        content: [
          { document: { format: "pdf", name: "scan", source: { bytes } } },
          { text: "hello" },
        ],
      },
    ]);
  });

  test("document name sanitized to Bedrock's allowed charset", async () => {
    setNextResponse(textResponse("x"));
    const { converseText } = await import("../lib/ai/bedrockConverse");
    const bytes = new Uint8Array([1]);
    // Periods and underscores are rejected by Bedrock; runs collapse to one space.
    await converseText({
      ...baseOpts,
      document: { bytes, name: "scan_v2.final.pdf" },
    });
    const msg = callLog[0]!.messages as Array<{
      content: Array<{ document?: { name?: string } }>;
    }>;
    expect(msg[0]!.content[0]!.document!.name).toBe("scan v2 final pdf");
  });

  test("name with no allowed chars falls back to 'document'", async () => {
    setNextResponse(textResponse("x"));
    const { converseText } = await import("../lib/ai/bedrockConverse");
    await converseText({
      ...baseOpts,
      document: { bytes: new Uint8Array([1]), name: "###" },
    });
    const msg = callLog[0]!.messages as Array<{
      content: Array<{ document?: { name?: string } }>;
    }>;
    expect(msg[0]!.content[0]!.document!.name).toBe("document");
  });
});

describe("provider selectors (bedrock)", () => {
  test("AI_PROVIDER=bedrock returns the bedrock item provider", async () => {
    process.env.AI_PROVIDER = "bedrock";
    const { getProvider, bedrockItemProvider } = await import(
      "../lib/ai/provider"
    );
    expect(getProvider()).toBe(bedrockItemProvider);
  });

  test("MATH_TRANSLATOR_PROVIDER=bedrock returns the bedrock translator", async () => {
    process.env.MATH_TRANSLATOR_PROVIDER = "bedrock";
    const { getMathTranslatorProvider, bedrockMathTranslator } = await import(
      "../lib/ai/mathTranslator/provider"
    );
    expect(getMathTranslatorProvider()).toBe(bedrockMathTranslator);
  });
});

// Slice 29: real Bedrock guardrail provider (ApplyGuardrail). Shares this
// file's fake BedrockRuntimeClient + resolver so there is a single
// @aws-sdk/client-bedrock-runtime module mock in the suite (two files
// mocking the same module collide on the shared fake state).
describe("bedrockGuardrail.check (ApplyGuardrail)", () => {
  test("allow: action NONE → allow, no findings; sends INPUT + DRAFT", async () => {
    setNextResponse({ action: "NONE", assessments: [] });
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    const r = await bedrockGuardrail.check("safe text", {
      stage: "input",
      surface: "item-gen",
    });
    expect(r).toEqual({ action: "allow", findings: [] });
    expect(callLog.length).toBe(1);
    expect(callLog[0]!.input.guardrailIdentifier).toBe("gr-test-123");
    expect(callLog[0]!.input.guardrailVersion).toBe("DRAFT");
    expect(callLog[0]!.input.source).toBe("INPUT");
    expect(callLog[0]!.input.content).toEqual([
      { text: { text: "safe text" } },
    ]);
  });

  test("block: intervened with a content filter → mapped finding", async () => {
    setNextResponse({
      action: "GUARDRAIL_INTERVENED",
      assessments: [{ contentPolicy: { filters: [{ type: "VIOLENCE" }] } }],
    });
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    const r = await bedrockGuardrail.check("nasty text", {
      stage: "output",
      surface: "item-gen",
    });
    expect(r.action).toBe("block");
    expect(r.findings).toEqual([{ type: "content_filter", detail: "VIOLENCE" }]);
    expect(callLog[0]!.input.source).toBe("OUTPUT");
  });

  test("block: PII + denied topic + custom word all mapped", async () => {
    setNextResponse({
      action: "GUARDRAIL_INTERVENED",
      assessments: [
        { topicPolicy: { topics: [{ name: "Medical Advice" }] } },
        {
          sensitiveInformationPolicy: {
            piiEntities: [
              { match: "123-45-6789", type: "US_SOCIAL_SECURITY_NUMBER" },
            ],
          },
        },
        { wordPolicy: { customWords: [{ match: "banned" }] } },
      ],
    });
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    const r = await bedrockGuardrail.check("x", {
      stage: "input",
      surface: "math-translate",
    });
    expect(r.action).toBe("block");
    // B4: the PII finding carries the entity CATEGORY, never `match`. These
    // findings are persisted to guardrail_events and returned to the browser.
    //
    // Security sweep: `blocked_word` carries NO detail. customWords reports
    // only `match` (the literal checked text) with no category to substitute,
    // so emitting it would contradict the GuardrailFinding contract — a
    // district that denylists student names would have had them echoed back by
    // the filter meant to catch them.
    expect(r.findings).toEqual([
      { type: "denied_topic", detail: "Medical Advice" },
      { type: "pii", detail: "US_SOCIAL_SECURITY_NUMBER" },
      { type: "blocked_word" },
    ]);
    const serialized = JSON.stringify(r.findings);
    expect(serialized).not.toContain("123-45-6789");
    expect(serialized).not.toContain("banned");
  });

  test("block with no parseable assessment → fallback finding", async () => {
    setNextResponse({ action: "GUARDRAIL_INTERVENED", assessments: [] });
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    const r = await bedrockGuardrail.check("x", {
      stage: "input",
      surface: "item-gen",
    });
    expect(r).toEqual({
      action: "block",
      findings: [{ type: "guardrail_intervened" }],
    });
  });

  test("honors GUARDRAIL_VERSION override", async () => {
    process.env.GUARDRAIL_VERSION = "3";
    setNextResponse({ action: "NONE" });
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    await bedrockGuardrail.check("x", { stage: "input", surface: "item-gen" });
    expect(callLog[0]!.input.guardrailVersion).toBe("3");
  });

  test("missing GUARDRAIL_ID → clear error, no call", async () => {
    delete process.env.GUARDRAIL_ID;
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    await expect(
      bedrockGuardrail.check("x", { stage: "input", surface: "item-gen" }),
    ).rejects.toThrow(/GUARDRAIL_ID is not set/);
    expect(callLog.length).toBe(0);
  });

  test("wraps an AWS service error as bedrock_guardrail_api_error_<status>", async () => {
    setNextError(new FakeAwsError("AccessDeniedException", 403, "nope"));
    const { bedrockGuardrail } = await import(
      "../lib/safeguarding/bedrockGuardrail"
    );
    await expect(
      bedrockGuardrail.check("x", { stage: "input", surface: "item-gen" }),
    ).rejects.toThrow(/bedrock_guardrail_api_error_403/);
  });

  test("GUARDRAIL_PROVIDER=bedrock returns the bedrock guardrail", async () => {
    process.env.GUARDRAIL_PROVIDER = "bedrock";
    const { getGuardrailProvider, bedrockGuardrail } = await import(
      "../lib/safeguarding/provider"
    );
    expect(getGuardrailProvider()).toBe(bedrockGuardrail);
  });
});
