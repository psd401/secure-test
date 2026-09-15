// Slice 2 of docs/scoring-corpus-design.md: the corpus runner's argument
// parsing. Pure — no DB, no provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CorpusArgsError, parseCorpusArgs } from "../lib/scoring/corpus";

let savedProvider: string | undefined;

beforeEach(() => {
  savedProvider = process.env.ESSAY_SCORER_PROVIDER;
  delete process.env.ESSAY_SCORER_PROVIDER;
});

afterEach(() => {
  if (savedProvider === undefined) delete process.env.ESSAY_SCORER_PROVIDER;
  else process.env.ESSAY_SCORER_PROVIDER = savedProvider;
});

const ID = "11111111-2222-3333-4444-555555555555";

describe("parseCorpusArgs", () => {
  test("a label is the only required input; everything else defaults", () => {
    const opts = parseCorpusArgs(["--label", "run one"]);
    expect(opts).toEqual({
      label: "run one",
      withHumanFinal: false,
      provider: "mock",
      concurrency: 1,
      dryRun: false,
    });
  });

  test("every flag round-trips, in --flag value and --flag=value form", () => {
    const opts = parseCorpusArgs([
      "--label=sonnet vs finals",
      "--assessment",
      ID,
      `--item=${ID}`,
      "--owner",
      "teacher-sub",
      "--with-human-final",
      "--since",
      "2026-09-01",
      "--limit",
      "25",
      "--provider",
      "bedrock",
      "--model",
      "us.anthropic.claude-haiku-4-5",
      "--concurrency",
      "4",
      "--dry-run",
    ]);
    expect(opts.label).toBe("sonnet vs finals");
    expect(opts.assessment).toBe(ID);
    expect(opts.item).toBe(ID);
    expect(opts.owner).toBe("teacher-sub");
    expect(opts.withHumanFinal).toBe(true);
    expect(opts.since?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(opts.limit).toBe(25);
    expect(opts.provider).toBe("bedrock");
    expect(opts.model).toBe("us.anthropic.claude-haiku-4-5");
    expect(opts.concurrency).toBe(4);
    expect(opts.dryRun).toBe(true);
  });

  test("the provider defaults from ESSAY_SCORER_PROVIDER, and --provider wins", () => {
    process.env.ESSAY_SCORER_PROVIDER = "bedrock";
    expect(parseCorpusArgs(["--label", "a"]).provider).toBe("bedrock");
    expect(parseCorpusArgs(["--label", "a", "--provider", "mock"]).provider).toBe("mock");
  });

  test.each([
    ["no label", []],
    ["a blank label", ["--label", "   "]],
    ["an unknown flag", ["--label", "a", "--assessments", ID]],
    ["a bare argument", ["--label", "a", "oops"]],
    ["a missing value", ["--label", "a", "--limit"]],
    ["a value that is the next flag", ["--label", "a", "--limit", "--dry-run"]],
    ["a repeated flag", ["--label", "a", "--limit", "1", "--limit", "2"]],
    ["a value on a boolean flag", ["--label", "a", "--dry-run=yes"]],
    ["a non-uuid assessment", ["--label", "a", "--assessment", "nope"]],
    ["a non-uuid item", ["--label", "a", "--item", "42"]],
    ["an unparseable --since", ["--label", "a", "--since", "last tuesday"]],
    ["a zero --limit", ["--label", "a", "--limit", "0"]],
    ["a fractional --limit", ["--label", "a", "--limit", "2.5"]],
    ["an unknown provider", ["--label", "a", "--provider", "anthropic"]],
    ["--concurrency 0", ["--label", "a", "--concurrency", "0"]],
    ["--concurrency past the cap", ["--label", "a", "--concurrency", "5"]],
    ["--model on the mock provider", ["--label", "a", "--model", "x"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseCorpusArgs(argv as string[])).toThrow(CorpusArgsError);
  });

  test("the rejection says what was wrong", () => {
    expect(() => parseCorpusArgs(["--label", "a", "--assessments", ID])).toThrow(
      /unknown flag "--assessments"/,
    );
    expect(() => parseCorpusArgs([])).toThrow(/--label is required/);
  });
});
