import { describe, expect, test } from "bun:test";
import { K12_MACROS } from "../src/macros.js";

describe("K12_MACROS", () => {
  test("exports the six K-12 helper macros", () => {
    expect(Object.keys(K12_MACROS).sort()).toEqual(
      [
        "\\degree",
        "\\half",
        "\\percent",
        "\\plusminus",
        "\\quarter",
        "\\third",
      ].sort(),
    );
  });

  test("every macro key is a backslash-prefixed LaTeX command", () => {
    for (const key of Object.keys(K12_MACROS)) {
      expect(key.startsWith("\\")).toBe(true);
    }
  });

  test("every macro value is a non-empty LaTeX expression", () => {
    for (const value of Object.values(K12_MACROS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test("frozen so callers can't mutate the canonical set", () => {
    expect(Object.isFrozen(K12_MACROS)).toBe(true);
  });
});

// K12_MACROS is vendored into PoC-B as a generated Swift constant by
// poc-b-test-loop/client/scripts/vendor-katex-macros.mjs, which is run BY HAND.
// Nothing failed if someone edited macros.ts and forgot — the macOS client
// would silently render a different macro set than the design tool, which is
// exactly the renderer drift slice 16 existed to eliminate (and the same class
// of bug as phase-1-2 review finding E16).
describe("K12_MACROS → PoC-B Swift codegen drift", () => {
  test("the checked-in GeneratedKatexMacros.swift matches the current macros", async () => {
    const { renderGeneratedSwift, GENERATED_SWIFT_PATH } = await import(
      "../../../poc-b-test-loop/client/scripts/vendor-katex-macros.mjs"
    );
    const onDisk = await Bun.file(GENERATED_SWIFT_PATH).text();
    expect(onDisk).toBe(renderGeneratedSwift(K12_MACROS));
  });

  test("the generated file actually contains every macro key and value", async () => {
    const { GENERATED_SWIFT_PATH } = await import(
      "../../../poc-b-test-loop/client/scripts/vendor-katex-macros.mjs"
    );
    const onDisk = await Bun.file(GENERATED_SWIFT_PATH).text();
    // The Swift raw string holds JSON whose backslashes are doubled.
    for (const [key, value] of Object.entries(K12_MACROS)) {
      expect(onDisk).toContain(JSON.stringify(key));
      expect(onDisk).toContain(JSON.stringify(value));
    }
  });

  test("importing the generator does not rewrite the file", async () => {
    const { GENERATED_SWIFT_PATH } = await import(
      "../../../poc-b-test-loop/client/scripts/vendor-katex-macros.mjs"
    );
    const before = await Bun.file(GENERATED_SWIFT_PATH).text();
    await import("../../../poc-b-test-loop/client/scripts/vendor-katex-macros.mjs");
    const after = await Bun.file(GENERATED_SWIFT_PATH).text();
    // If the import had a write side effect, the drift check above would
    // regenerate the file and then trivially pass — proving nothing.
    expect(after).toBe(before);
  });
});

// 2026-09-01: the shipping client (client/SecureTestCore) vendors the same
// macro set through client/scripts/vendor-katex.mjs, alongside the KaTeX
// build it copies from design-tool's node_modules. Same drift check.
describe("K12_MACROS → shipping-client Swift codegen drift", () => {
  test("the checked-in client GeneratedKatexMacros.swift matches the current macros + vendored version", async () => {
    const { renderGeneratedSwift, GENERATED_SWIFT_PATH } = await import(
      "../../../client/scripts/vendor-katex.mjs"
    );
    const versionFile = GENERATED_SWIFT_PATH.replace(
      /GeneratedKatexMacros\.swift$/,
      "Resources/katex/VERSION",
    );
    const version = (await Bun.file(versionFile).text()).trim();
    const onDisk = await Bun.file(GENERATED_SWIFT_PATH).text();
    expect(onDisk).toBe(renderGeneratedSwift(K12_MACROS, version));
  });

  test("the vendored KaTeX is the version design-tool renders with", async () => {
    const pkg = await import("../../../design-tool/node_modules/katex/package.json");
    const { GENERATED_SWIFT_PATH } = await import("../../../client/scripts/vendor-katex.mjs");
    const onDisk = await Bun.file(GENERATED_SWIFT_PATH).text();
    expect(onDisk).toContain(`static let katexVersion = "${pkg.version}"`);
  });
});
