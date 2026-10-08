import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESSAY_HTML_MAX_LENGTH,
  ESSAY_TEXT_MAX_LENGTH,
  ItemResponseSchema,
  RESPONSE_CELL_MAX_LENGTH,
  SHORT_TEXT_MAX_LENGTH,
} from "@secure-test/schema";
import { UPLOAD_MAX_BYTES } from "../lib/api/responseUploads";

// Bridge audit B-7 / H-3 (2026-10-08, docs/server-delivered-renderer-design.md):
// the client refuses a page payload over the server's limits before it is
// spooled, so the two sides must agree. This reads the client's
// `BridgeLimits` out of its Swift source and fails on any drift.
const swiftSource = readFileSync(
  join(
    import.meta.dir,
    "../../client/SecureTestCore/Sources/SecureTestCore/BridgeChecks.swift",
  ),
  "utf8",
);

function swiftLimit(name: string): number {
  const match = swiftSource.match(
    new RegExp(`static let ${name} = ([0-9_ *]+)\\n`),
  );
  const expression = match?.[1];
  if (!expression) throw new Error(`BridgeLimits.${name} not found in BridgeChecks.swift`);
  return expression
    .replaceAll("_", "")
    .split("*")
    .map((factor) => Number(factor.trim()))
    .reduce((a, b) => a * b, 1);
}

describe("client BridgeLimits match the server", () => {
  test("answer text limits", () => {
    expect(swiftLimit("essayTextMaxLength")).toBe(ESSAY_TEXT_MAX_LENGTH);
    expect(swiftLimit("shortTextMaxLength")).toBe(SHORT_TEXT_MAX_LENGTH);
    expect(swiftLimit("essayHTMLMaxLength")).toBe(ESSAY_HTML_MAX_LENGTH);
    expect(swiftLimit("cellMaxLength")).toBe(RESPONSE_CELL_MAX_LENGTH);
  });

  test("drawing limit", () => {
    expect(swiftLimit("drawingMaxBytes")).toBe(UPLOAD_MAX_BYTES);
  });
});

describe("answer text limits (B-7)", () => {
  test("an essay at the limit is accepted, one over is refused", () => {
    const at = "a".repeat(ESSAY_TEXT_MAX_LENGTH);
    expect(ItemResponseSchema.safeParse({ type: "essay", text: at }).success).toBe(true);
    expect(ItemResponseSchema.safeParse({ type: "essay", text: `${at}a` }).success).toBe(false);
  });

  test("a short answer at the limit is accepted, one over is refused", () => {
    const at = "a".repeat(SHORT_TEXT_MAX_LENGTH);
    expect(ItemResponseSchema.safeParse({ type: "short_text", text: at }).success).toBe(true);
    expect(
      ItemResponseSchema.safeParse({ type: "short_text", text: `${at}a` }).success,
    ).toBe(false);
  });
});
