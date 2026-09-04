import { describe, expect, test } from "bun:test";
import {
  TIDE_CATALOG,
  mapTideToCatalogId,
  validateObserved,
  type TideTriple,
} from "../lib/accommodations/tideCatalog";
import { ACCOMMODATION_CATALOG } from "../lib/accommodations/catalog";

describe("TIDE_CATALOG (slice 23a)", () => {
  test("loads all 448 rows from the committed JSON", () => {
    expect(TIDE_CATALOG.length).toBe(448);
  });

  test("every catalog row has the required shape", () => {
    for (const row of TIDE_CATALOG) {
      expect(typeof row.subject).toBe("string");
      expect(typeof row.tool).toBe("string");
      expect(typeof row.value).toBe("string");
      expect(typeof row.code).toBe("string");
      expect(row.subject.length).toBeGreaterThan(0);
      expect(row.tool.length).toBeGreaterThan(0);
      expect(row.value.length).toBeGreaterThan(0);
    }
  });

  test("subjects are exactly the four TIDE labels", () => {
    const subjects = new Set(TIDE_CATALOG.map((r) => r.subject));
    expect([...subjects].sort()).toEqual([
      "ELA-CAT",
      "ELA-PT",
      "Mathematics",
      "Science",
    ]);
  });
});

describe("mapTideToCatalogId", () => {
  test("happy path: known triple resolves to a design-tool catalog id", () => {
    const mapped = mapTideToCatalogId("Mathematics", "Color Contrast", "Black on Rose");
    expect(mapped).not.toBeNull();
    expect(mapped!.tool_id).toBe("color_contrast");
    expect(mapped!.tide_code).toBe("TDS_CCMagenta");
    expect(mapped!.value).toBe("Black on Rose");
    // ospi_tier comes from the design-tool catalog
    expect(mapped!.ospi_tier).toBe("designated");
  });

  test("highlighter (uppercase OFF) round-trips per TIDE's own casing", () => {
    // TIDE uses uppercase OFF for Highlighter specifically; the import
    // must respect that casing.
    const off = mapTideToCatalogId("ELA-CAT", "Highlighter", "OFF");
    expect(off).not.toBeNull();
    expect(off!.tool_id).toBe("highlighter");
    expect(off!.tide_code).toBe("TDS_Highlight0");

    const on = mapTideToCatalogId("ELA-CAT", "Highlighter", "On");
    expect(on).not.toBeNull();
    expect(on!.tide_code).toBe("TDS_HighlightColors");
  });

  test("unknown triple returns null (catalog drift)", () => {
    expect(
      mapTideToCatalogId("Mathematics", "Color Contrast", "Black on Mauve"),
    ).toBeNull();
  });

  test("unmapped tool returns null even when value is valid", () => {
    // "Non-Embedded Accommodations" is a real TIDE tool but isn't
    // mapped to a design-tool catalog id in slice 23a (Phase 2 work).
    const m = mapTideToCatalogId(
      "Mathematics",
      "Non-Embedded Accommodations",
      "Abacus",
    );
    expect(m).toBeNull();
  });

  test("subject-scoped: a tool unavailable for a subject returns null", () => {
    // Translated Glossaries is Math+Science only per the data dictionary.
    expect(
      mapTideToCatalogId(
        "ELA-CAT",
        "Translated Glossaries",
        "Spanish",
      ),
    ).toBeNull();
  });
});

describe("validateObserved", () => {
  test("returns empty unmapped for a known-good triple set", () => {
    const known: TideTriple[] = [
      { subject: "Mathematics", tool: "Color Contrast", value: "Black on Rose" },
      { subject: "all" /* not real */ as unknown as string, tool: "x", value: "y" },
    ];
    // Only the first triple should resolve; second falls in unmapped.
    const out = validateObserved(known);
    expect(out.unmapped.length).toBe(1);
    expect(out.unmapped[0]!.tool).toBe("x");
  });
});

describe("mapped tools cross-reference catalog.ts", () => {
  test("every TIDE_TOOL_TO_ID target id exists in ACCOMMODATION_CATALOG", () => {
    // Probe a representative sample by exercising mapTideToCatalogId on
    // each distinct (subject, tool) pair the lookup map can resolve.
    const seenIds = new Set<string>();
    for (const row of TIDE_CATALOG) {
      const m = mapTideToCatalogId(row.subject, row.tool, row.value);
      if (m) seenIds.add(m.tool_id);
    }
    // Anchor: at least 20 distinct design-tool catalog ids should
    // surface via the mapping (29 distinct tools mapped × subject
    // coverage, but several tools share an id like Test Display
    // Language → test_language, so we keep the floor conservative).
    expect(seenIds.size).toBeGreaterThanOrEqual(20);

    const catalogIds = new Set(ACCOMMODATION_CATALOG.map((e) => e.id));
    for (const id of seenIds) {
      expect(catalogIds.has(id)).toBe(true);
    }
  });
});
