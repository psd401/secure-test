import { describe, expect, test } from "bun:test";
import { defaultLayoutAfterAddingSource } from "@/lib/itemSetLayout";

// C-8(b) (docs/multi-source-stimulus-design.md): adding the first source to
// an inline set defaults its layout to side_by_side; every other case is
// left alone.
describe("defaultLayoutAfterAddingSource", () => {
  test("flips inline to side_by_side on the first source", () => {
    expect(defaultLayoutAfterAddingSource("inline", 0)).toBe("side_by_side");
  });

  test("leaves inline alone on a second source", () => {
    expect(defaultLayoutAfterAddingSource("inline", 1)).toBe("inline");
  });

  test("leaves side_by_side alone", () => {
    expect(defaultLayoutAfterAddingSource("side_by_side", 0)).toBe("side_by_side");
  });

  test("leaves own_page alone", () => {
    expect(defaultLayoutAfterAddingSource("own_page", 0)).toBe("own_page");
  });
});
