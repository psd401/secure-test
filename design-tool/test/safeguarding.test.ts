// Slice 28: safeguarding wrapper + mock guardrail. No DB required — the
// telemetry recorder is injected as a capturing fake, and the guardrail
// provider is passed explicitly, so this suite runs without DATABASE_URL.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mockGuardrail } from "../lib/safeguarding/mockProvider";
import { getGuardrailProvider } from "../lib/safeguarding/provider";
import { runGuarded } from "../lib/safeguarding/guard";
import type { GuardrailEventInput } from "../lib/safeguarding/telemetry";
import { itemProposalText } from "../lib/safeguarding/itemText";
import type { CreateItemBody } from "../lib/api/items";

describe("mockGuardrail", () => {
  test("allows ordinary content", async () => {
    const r = await mockGuardrail.check("What is 2 + 2?", {
      stage: "input",
      surface: "item-gen",
    });
    expect(r.action).toBe("allow");
    expect(r.findings).toEqual([]);
  });

  test("blocks the BLOCKME sentinel as a blocked_term", async () => {
    const r = await mockGuardrail.check("please BLOCKME now", {
      stage: "output",
      surface: "item-gen",
    });
    expect(r.action).toBe("block");
    expect(r.findings).toEqual([{ type: "blocked_term", detail: "blockme" }]);
  });

  test("blocks an SSN shape as pii", async () => {
    const r = await mockGuardrail.check("ssn 123-45-6789", {
      stage: "input",
      surface: "math-translate",
    });
    expect(r.action).toBe("block");
    expect(r.findings).toEqual([{ type: "pii", detail: "ssn_shape" }]);
  });
});

describe("getGuardrailProvider", () => {
  let original: string | undefined;
  beforeAll(() => {
    original = process.env.GUARDRAIL_PROVIDER;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.GUARDRAIL_PROVIDER;
    else process.env.GUARDRAIL_PROVIDER = original;
  });
  afterEach(() => {
    delete process.env.GUARDRAIL_PROVIDER;
  });

  test("defaults to off → null (no provider, no telemetry)", () => {
    expect(getGuardrailProvider()).toBeNull();
  });

  test("GUARDRAIL_PROVIDER=mock returns the mock guardrail", () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    expect(getGuardrailProvider()).toBe(mockGuardrail);
  });

  test("unknown provider throws referencing the ADR", () => {
    process.env.GUARDRAIL_PROVIDER = "definitely-not-real";
    expect(() => getGuardrailProvider()).toThrow(/0012-safeguarding/);
  });
});

// Helper: a capturing recorder so tests can assert on persisted events
// without a database.
function captureRecorder() {
  const events: GuardrailEventInput[] = [];
  return {
    events,
    record: async (e: GuardrailEventInput) => {
      events.push(e);
    },
  };
}

describe("runGuarded", () => {
  test("null provider (off) runs directly with no telemetry", async () => {
    const { events, record } = captureRecorder();
    let ran = 0;
    const outcome = await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: "anything",
        run: async () => {
          ran += 1;
          return "RESULT";
        },
        outputText: (r) => r,
      },
      { provider: null, record },
    );
    expect(outcome).toEqual({ ok: true, result: "RESULT" });
    expect(ran).toBe(1);
    expect(events.length).toBe(0);
  });

  test("clean input + output → ok, records two allow events", async () => {
    const { events, record } = captureRecorder();
    const outcome = await runGuarded(
      {
        surface: "math-translate",
        ownerSub: "teacher-1",
        inputText: "one half",
        run: async () => "\\frac{1}{2}",
        outputText: (r) => r,
      },
      { provider: mockGuardrail, record },
    );
    expect(outcome.ok).toBe(true);
    expect(events.map((e) => [e.stage, e.action])).toEqual([
      ["input", "allow"],
      ["output", "allow"],
    ]);
    expect(events[0]!.provider_id).toBe("mock");
    expect(events[0]!.surface).toBe("math-translate");
  });

  test("blocked input skips the model and records one block event", async () => {
    const { events, record } = captureRecorder();
    let ran = 0;
    const outcome = await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: "write a BLOCKME item",
        run: async () => {
          ran += 1;
          return "should not run";
        },
        outputText: (r) => r,
      },
      { provider: mockGuardrail, record },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("input");
      expect(outcome.findings).toEqual([
        { type: "blocked_term", detail: "blockme" },
      ]);
    }
    expect(ran).toBe(0);
    expect(events.length).toBe(1);
    expect(events[0]!.action).toBe("block");
  });

  test("clean input but blocked output → output block, two events", async () => {
    const { events, record } = captureRecorder();
    const outcome = await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: "make an item",
        run: async () => "contains 123-45-6789",
        outputText: (r) => r,
      },
      { provider: mockGuardrail, record },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe("output");
      expect(outcome.findings).toEqual([{ type: "pii", detail: "ssn_shape" }]);
    }
    expect(events.map((e) => [e.stage, e.action])).toEqual([
      ["input", "allow"],
      ["output", "block"],
    ]);
  });

  // Security sweep: MATCH_BEARING_FINDING_TYPES (strip a verbatim match from
  // `detail`) and SNIPPET_SUPPRESSING_FINDING_TYPES (don't persist the checked
  // text at all) were one conflated set. They are different concerns, and
  // blocked_word needs the first without the second.
  test("a blocked_word match is stripped from detail but keeps its snippet", async () => {
    const { events, record } = captureRecorder();
    const provider = {
      id: "test",
      async check() {
        // A provider that regresses to emitting the matched text verbatim.
        return {
          action: "block" as const,
          findings: [{ type: "blocked_word", detail: "blockme" }],
        };
      },
    };
    const outcome = await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: "please blockme now",
        run: async () => "unused",
        outputText: (r: string) => r,
      },
      { provider, record },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Detail stripped — it appeared verbatim in the checked text.
      expect(outcome.findings).toEqual([{ type: "blocked_word" }]);
    }
    // ...but the snippet survives, because the checked text is not itself
    // sensitive the way a PII hit is. Losing it would destroy triage context
    // while protecting nothing.
    expect(events[0]!.text_snippet).toBe("please blockme now");
  });

  test("a pii finding suppresses the snippet entirely", async () => {
    const { events, record } = captureRecorder();
    await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: "ssn 123-45-6789",
        run: async () => "unused",
        outputText: (r: string) => r,
      },
      { provider: mockGuardrail, record },
    );
    // The whole point of a PII block is that the text contains PII.
    expect(events[0]!.text_snippet).not.toContain("123-45-6789");
    expect(events[0]!.text_snippet).toBe("[redacted — sensitive finding]");
  });

  test("telemetry failure is swallowed, not propagated", async () => {
    const throwingRecord = async () => {
      throw new Error("db down");
    };
    const outcome = await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: "fine",
        run: async () => "also fine",
        outputText: (r) => r,
      },
      { provider: mockGuardrail, record: throwingRecord },
    );
    expect(outcome).toEqual({ ok: true, result: "also fine" });
  });

  test("persists a truncated snippet for long text", async () => {
    const { events, record } = captureRecorder();
    const long = "a".repeat(900);
    await runGuarded(
      {
        surface: "item-gen",
        ownerSub: "teacher-1",
        inputText: long,
        run: async () => "short",
        outputText: (r) => r,
      },
      { provider: mockGuardrail, record },
    );
    const inputEvent = events.find((e) => e.stage === "input")!;
    expect(inputEvent.text_snippet.length).toBe(501); // 500 chars + ellipsis
    expect(inputEvent.text_snippet.endsWith("…")).toBe(true);
  });
});

describe("itemProposalText", () => {
  test("flattens stem + choice texts for an MC item", () => {
    const item: CreateItemBody = {
      type: "multiple_choice_single",
      stem: "Pick the prime",
      choices: [
        { id: "a", text: "4" },
        { id: "b", text: "7" },
      ],
      correct_choice_ids: ["b"],
    };
    expect(itemProposalText(item)).toBe("Pick the prime\n4\n7");
  });

  test("flattens stem + answer for a short-text item", () => {
    const item: CreateItemBody = {
      type: "short_text",
      stem: "Capital of WA?",
      choices: [],
      correct_choice_ids: [],
      correct_answer: "Olympia",
    };
    expect(itemProposalText(item)).toBe("Capital of WA?\nOlympia");
  });

  // E20: parseItemText blind-casts JSON.parse output, so the static type is a
  // lie at runtime. runGuarded does NOT wrap outputText(), so a TypeError here
  // escaped as a 502 provider_failed instead of the accurate
  // provider_returned_invalid_item that CreateItemBody.safeParse produces
  // right after. Must be total for any runtime value.
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "just text"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["choices as a non-array", { type: "multiple_choice_single", stem: "S", choices: "nope" }],
    ["a null entry in choices", { type: "multiple_choice_single", stem: "S", choices: [null] }],
    ["a non-string correct_answer", { type: "short_text", stem: "S", correct_answer: 7 }],
  ])("returns a string for off-contract shape: %s", (_label, value) => {
    expect(typeof itemProposalText(value as never)).toBe("string");
  });

  test("still extracts what it can from a partially-valid shape", () => {
    expect(
      itemProposalText({
        type: "multiple_choice_single",
        stem: "Stem survives",
        choices: [null, { id: "a", text: "A" }],
      } as never),
    ).toBe("Stem survives\nA");
  });
});
