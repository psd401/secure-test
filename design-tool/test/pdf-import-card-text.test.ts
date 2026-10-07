// S-f-1: the PDF panel's proposal card drops the importer's `\$` escape
// (C-2) for its one-line plain-text preview; nothing else changes.
import { describe, expect, test } from "bun:test";
import { cardText } from "../components/app/RenderedText";

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

describe("itemTypeName (HC-2)", () => {
  test("teacher wording for known types, de-underscored otherwise", async () => {
    const { itemTypeName } = await import("../lib/items/typeLabel");
    expect(itemTypeName("short_text")).toBe("Short answer");
    expect(itemTypeName("drawing_upload")).toBe("Drawing");
    // FB slice 1: fill_blank is a known type now (D-10), so the unknown-type
    // example moved to a name no type uses.
    expect(itemTypeName("fill_blank")).toBe("Fill in the blank");
    expect(itemTypeName("sort_into_bins")).toBe("sort into bins");
  });
});

// FB slice 4: the PDF card's "Needs answer key" badge and its gap display.
describe("fill-in-the-blank card (FB slice 4)", () => {
  test("no keyed blank → the badge; one keyed blank → none; other types unchanged", async () => {
    const { candidateNeedsKey } = await import("../app/dashboard/[id]/PdfImportPanel");
    expect(candidateNeedsKey({ type: "fill_blank", stem: "A [[b1]].", blanks: [{ id: "b1", kind: "text" }] })).toBe(true);
    expect(
      candidateNeedsKey({
        type: "fill_blank",
        stem: "A [[b1]] and [[b2]].",
        blanks: [
          { id: "b1", kind: "text", keys: ["x"] },
          { id: "b2", kind: "dropdown", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }] },
        ],
      }),
    ).toBe(false);
    expect(candidateNeedsKey({ type: "short_text", stem: "Q", correct_answer: "" })).toBe(true);
    expect(candidateNeedsKey({ type: "essay", stem: "Q" })).toBe(false);
  });
  test("markers read as gaps on the card", async () => {
    const { stemWithGaps } = await import("../lib/items/fillBlankEditor");
    expect(stemWithGaps("The [[b1]] side and the [[b2]] side.")).toBe("The ____ side and the ____ side.");
    expect(stemWithGaps("No markers.")).toBe("No markers.");
  });
});
