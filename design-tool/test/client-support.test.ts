import { describe, expect, test } from "bun:test";
import { parseClientVersion, requiredClientUpgrade } from "../lib/items/clientSupport";

describe("requiredClientUpgrade (FB slice 6, D-4)", () => {
  test("parses marketing versions", () => {
    expect(parseClientVersion("1.5.0")).toEqual([1, 5, 0]);
    expect(parseClientVersion("2.0")).toEqual([2, 0, 0]);
    expect(parseClientVersion("1.10.3 (42)")).toEqual([1, 10, 3]);
    expect(parseClientVersion("unknown")).toBeNull();
    expect(parseClientVersion(null)).toBeNull();
  });
  test("types without a minimum never need an upgrade", () => {
    expect(requiredClientUpgrade(null, ["essay", "table", "match"])).toBeNull();
  });
  test("fill_blank needs 1.6.0; missing or unreadable versions are too old", () => {
    expect(requiredClientUpgrade(null, ["essay", "fill_blank"])).toBe("1.6.0");
    expect(requiredClientUpgrade("unknown", ["fill_blank"])).toBe("1.6.0");
    expect(requiredClientUpgrade("1.5.9", ["fill_blank"])).toBe("1.6.0");
    expect(requiredClientUpgrade("1.10.0", ["fill_blank"])).toBeNull();
    expect(requiredClientUpgrade("1.6.0", ["fill_blank", "fill_blank"])).toBeNull();
  });
});
