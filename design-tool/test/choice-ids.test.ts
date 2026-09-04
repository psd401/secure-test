import { describe, expect, test } from "bun:test";
import { nextChoiceId } from "../lib/items/choiceIds";

describe("nextChoiceId", () => {
  test("returns 'a' for an empty choice list", () => {
    expect(nextChoiceId([])).toBe("a");
  });

  test("returns the next sequential letter when prior ids are a/b/c", () => {
    expect(nextChoiceId([{ id: "a" }, { id: "b" }, { id: "c" }])).toBe("d");
  });

  test("fills the first gap when ids skip ahead", () => {
    expect(nextChoiceId([{ id: "a" }, { id: "c" }, { id: "d" }])).toBe("b");
  });

  test("ignores non-letter ids when picking the next letter", () => {
    expect(nextChoiceId([{ id: "red" }, { id: "blue" }])).toBe("a");
  });

  test("returns the next letter alongside non-letter ids", () => {
    expect(nextChoiceId([{ id: "a" }, { id: "custom" }, { id: "b" }])).toBe("c");
  });

  test("overflows past z to aa, then ab, …", () => {
    const all26 = Array.from({ length: 26 }, (_, i) => ({
      id: String.fromCharCode(97 + i),
    }));
    expect(nextChoiceId(all26)).toBe("aa");
    expect(nextChoiceId([...all26, { id: "aa" }])).toBe("ab");
  });
});
