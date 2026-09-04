import { describe, expect, test } from "bun:test";
import {
  assetIdsFromItemConfig,
  extractAssetRefs,
  extractAssetRefsFromMany,
} from "../lib/items/extractAssetRefs";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

describe("extractAssetRefs", () => {
  test("returns empty for non-string or empty input", () => {
    expect(extractAssetRefs("")).toEqual([]);
    expect(extractAssetRefs(undefined as unknown as string)).toEqual([]);
  });

  test("finds a single ref", () => {
    expect(extractAssetRefs(`See ![chart](asset:${UUID_A}) below.`)).toEqual([
      UUID_A,
    ]);
  });

  test("finds multiple refs in order", () => {
    const text = `One ![a](asset:${UUID_A}) and two ![b](asset:${UUID_B}).`;
    expect(extractAssetRefs(text)).toEqual([UUID_A, UUID_B]);
  });

  test("ignores non-asset link syntax", () => {
    expect(extractAssetRefs(`![](https://example.com/x.png)`)).toEqual([]);
    expect(extractAssetRefs(`See [chart](asset:${UUID_A})`)).toEqual([]); // missing the leading !
  });

  test("rejects refs whose uuid is malformed", () => {
    expect(extractAssetRefs(`![x](asset:not-a-uuid)`)).toEqual([]);
  });

  test("is case-insensitive on the uuid hex chars", () => {
    const upper = UUID_A.toUpperCase();
    expect(extractAssetRefs(`![x](asset:${upper})`)).toEqual([UUID_A]);
  });

  test("extractAssetRefsFromMany dedupes across inputs", () => {
    const out = extractAssetRefsFromMany([
      `![a](asset:${UUID_A})`,
      `more ![a](asset:${UUID_A}) here`,
      `another ![b](asset:${UUID_B})`,
    ]);
    expect(out.sort()).toEqual([UUID_A, UUID_B].sort());
  });
});

// Code-review fix (2026-08-14): config asset ids are collected through ONE
// helper shared by export bundling and preview resolution, and non-uuid
// refs are dropped so the uuid-column inArray query can never 22P02.
describe("assetIdsFromItemConfig", () => {
  test("collects hotspot + drawing refs, lowercased", () => {
    expect(
      assetIdsFromItemConfig({
        image_asset_id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        prompt_asset_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      }),
    ).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
  });

  test("drops non-uuid and missing refs", () => {
    expect(
      assetIdsFromItemConfig({ image_asset_id: "ref-1", prompt_asset_id: null }),
    ).toEqual([]);
    expect(assetIdsFromItemConfig({})).toEqual([]);
    expect(assetIdsFromItemConfig(undefined)).toEqual([]);
    // 36 chars of hex/dashes but not uuid-shaped — the loose shape the
    // review flagged; must NOT pass.
    expect(
      assetIdsFromItemConfig({
        image_asset_id: "aaaaaaaaa-aaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).toEqual([]);
  });
});
