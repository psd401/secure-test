import { describe, expect, test } from "bun:test";
import { uniqueImportName } from "../lib/api/importBundle";

describe("uniqueImportName (2026-09-02)", () => {
  test("plain when free; (copy); then (copy N)", () => {
    expect(uniqueImportName([], "Unit 1")).toBe("Unit 1");
    expect(uniqueImportName(["Unit 1"], "Unit 1")).toBe("Unit 1 (copy)");
    expect(uniqueImportName(["Unit 1", "Unit 1 (copy)"], "Unit 1")).toBe("Unit 1 (copy 2)");
    expect(uniqueImportName(["Unit 1", "Unit 1 (copy)", "Unit 1 (copy 2)"], "Unit 1")).toBe("Unit 1 (copy 3)");
    expect(uniqueImportName(["Unit 1 (copy)"], "Unit 1")).toBe("Unit 1");
  });
});
