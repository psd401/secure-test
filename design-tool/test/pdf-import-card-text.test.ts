// S-f-1: the PDF panel's proposal card drops the importer's `\$` escape
// (C-2) for its one-line plain-text preview; nothing else changes.
import { describe, expect, test } from "bun:test";
import { cardText } from "../app/dashboard/[id]/PdfImportPanel";

describe("cardText (S-f-1)", () => {
  test("drops the backslash before an escaped dollar", () => {
    expect(cardText("A car costs \\$57,600 and \\$1,200 more")).toBe(
      "A car costs $57,600 and $1,200 more",
    );
  });
  test("leaves math delimiters and plain text alone", () => {
    expect(cardText("Solve $x^2 = 4$ for x")).toBe("Solve $x^2 = 4$ for x");
    expect(cardText("No money here")).toBe("No money here");
  });
});
