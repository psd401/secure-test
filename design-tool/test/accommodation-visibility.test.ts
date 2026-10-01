import { describe, expect, test } from "bun:test";
import {
  ACCOMMODATION_CATALOG,
  VISIBLE_ACCOMMODATION_CATALOG,
  isValidAccommodationId,
  isVisibleAccommodation,
} from "../lib/accommodations/catalog";

// Portfolio focus (2026-10-01): hidden tools are hidden from teachers, not
// removed — every id stays valid for stored rows, TIDE imports and bundles.
describe("accommodation visibility", () => {
  test("the visible set is the delivered tools plus the TTS / STT builds", () => {
    expect(VISIBLE_ACCOMMODATION_CATALOG.map((e) => e.id).sort()).toEqual(
      [
        "color_contrast",
        "optional_font",
        "speech_to_text",
        "spell_check",
        "tts_for_ela_reading",
        "tts_spanish",
        "tts_student_responses",
        "tts_test_content",
        "zoom",
      ].sort(),
    );
  });

  test("every visible id is a catalog id (a typo would hide a tool silently)", () => {
    for (const e of VISIBLE_ACCOMMODATION_CATALOG) expect(isValidAccommodationId(e.id)).toBe(true);
  });

  test("hidden tools stay valid ids", () => {
    const hidden = ACCOMMODATION_CATALOG.filter((e) => !isVisibleAccommodation(e.id));
    expect(hidden.length).toBe(ACCOMMODATION_CATALOG.length - VISIBLE_ACCOMMODATION_CATALOG.length);
    for (const e of hidden) expect(isValidAccommodationId(e.id)).toBe(true);
    // Every non-embedded (strategy D) entry is hidden.
    for (const e of ACCOMMODATION_CATALOG.filter((x) => x.strategy === "D")) {
      expect(isVisibleAccommodation(e.id)).toBe(false);
    }
  });
});
