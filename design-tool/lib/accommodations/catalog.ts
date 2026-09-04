// Catalog of OSPI accommodations + universal tools surfaced by the
// assessment-level "allowed accommodations" picker.
//
// Source of truth: docs/accommodations.md (OSPI 2025-26 GTSA catalog
// mapped to PSD strategy taxonomy). TIDE field-level mapping for any
// per-student import lives in docs/accommodations-data-dictionary.md.
//
// Decision per the picker-scope rule in docs/accommodations.md: surface
// ALL OSPI tools regardless of impl_tier, so the metadata is forward-
// compatible. Tools the district browser doesn't render yet (T3/T4 + oob)
// no-op at runtime but the picker state survives. Excluded entries are
// universal-baseline functionality teachers don't toggle (Breaks,
// Keyboard Navigation, Writing Tools).
//
// IDs are stable: once shipped, do not rename — they live in DB rows
// (assessments.allowed_accommodations jsonb) and in exported JSON.

export type OspiTier = "universal" | "designated" | "accommodation";

/**
 * Implementation tier (per docs/accommodations.md "Implementation tiers"
 * section). Drives the badge in the picker UI.
 *
 * - T1: Phase 1 MVP candidates, CSS/HTML only.
 * - T2: Phase 2, real engineering, no external blockers.
 * - T3: Phase 3, content-driven or needs teacher monitor.
 * - T4: distant — external blockers or hardware integration.
 * - oob: out-of-band only (captured + shown to TA; app never acts).
 */
export type ImplTier = "T1" | "T2" | "T3" | "T4" | "oob";

/**
 * Strategy classification (per docs/accommodations.md taxonomy).
 *
 * - A: in-app feature (WKWebView + AppKit).
 * - B: AAC setConfiguration — allow AT-app bundle ID.
 * - C: AAC per-session flag (allowsSpellCheck, etc.).
 * - D: out-of-band (paper, human, external device).
 */
export type Strategy = "A" | "B" | "C" | "D";

export interface AccommodationCatalogEntry {
  id: string;
  label: string;
  ospi_tier: OspiTier;
  impl_tier: ImplTier;
  strategy: Strategy;
  notes?: string;
}

export const ACCOMMODATION_CATALOG: readonly AccommodationCatalogEntry[] = [
  // ---- Universal Tools ----
  { id: "desmos_calculator", label: "Desmos Calculator", ospi_tier: "universal", impl_tier: "T2", strategy: "A" },
  { id: "digital_notepad", label: "Digital Notepad", ospi_tier: "universal", impl_tier: "T2", strategy: "A" },
  { id: "english_dictionary", label: "English Dictionary", ospi_tier: "universal", impl_tier: "T2", strategy: "A" },
  { id: "english_glossary", label: "English Glossary", ospi_tier: "universal", impl_tier: "T3", strategy: "A", notes: "Content-driven: needs per-item glossary data." },
  { id: "expandable_items", label: "Expandable Items", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "expandable_stimuli", label: "Expandable Stimuli", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "global_notes", label: "Global Notes", ospi_tier: "universal", impl_tier: "T2", strategy: "A" },
  { id: "highlighter", label: "Highlighter", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "line_reader", label: "Line Reader", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "mark_for_review", label: "Mark for Review", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "optional_font", label: "Optional Font (dyslexia-friendly)", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "periodic_table", label: "Periodic Table", ospi_tier: "universal", impl_tier: "T2", strategy: "A" },
  { id: "spell_check", label: "Spell Check", ospi_tier: "universal", impl_tier: "T2", strategy: "A" },
  { id: "strikethrough", label: "Strikethrough", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "zoom", label: "Zoom (in-app)", ospi_tier: "universal", impl_tier: "T1", strategy: "A" },
  { id: "scratch_paper", label: "Scratch Paper", ospi_tier: "universal", impl_tier: "oob", strategy: "D" },

  // ---- Designated Supports ----
  { id: "color_contrast", label: "Color Contrast", ospi_tier: "designated", impl_tier: "T1", strategy: "A" },
  { id: "hybrid_masking_tool", label: "Hybrid Masking Tool", ospi_tier: "designated", impl_tier: "T1", strategy: "A" },
  { id: "illustration_glossaries", label: "Illustration Glossaries", ospi_tier: "designated", impl_tier: "T3", strategy: "A", notes: "Content-driven: needs per-term illustration assets." },
  { id: "masking", label: "Masking", ospi_tier: "designated", impl_tier: "T1", strategy: "A" },
  { id: "mouse_pointer", label: "Mouse Pointer (size/color)", ospi_tier: "designated", impl_tier: "T2", strategy: "A", notes: "Strategy may shift to C post-AAC-entitlement verification." },
  { id: "streamlined_interface_mode", label: "Streamlined Interface Mode", ospi_tier: "designated", impl_tier: "T1", strategy: "A" },
  { id: "tts_test_content", label: "Text-to-Speech (Test Content)", ospi_tier: "designated", impl_tier: "T2", strategy: "A" },
  { id: "tts_student_responses", label: "Text-to-Speech (Student Responses)", ospi_tier: "designated", impl_tier: "T2", strategy: "A" },
  { id: "translated_glossaries", label: "Translated Glossaries (13 languages)", ospi_tier: "designated", impl_tier: "T3", strategy: "A", notes: "Per-item glossary data per language." },
  { id: "translated_test_directions", label: "Translated Test Directions (Spanish)", ospi_tier: "designated", impl_tier: "T4", strategy: "A", notes: "Needs Spanish-authored directions." },
  { id: "test_language", label: "Test Display Language (English/Spanish/Braille)", ospi_tier: "designated", impl_tier: "T4", strategy: "A", notes: "Needs Spanish-authored items or auto-translation." },
  { id: "language_display", label: "Language Display (bilingual layout)", ospi_tier: "designated", impl_tier: "T4", strategy: "A", notes: "Only meaningful with test_language=Spanish." },
  { id: "amplification", label: "Amplification", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "bilingual_dictionary", label: "Bilingual Dictionary (paper)", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "color_overlays", label: "Color Overlays (physical)", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "illustration_glossaries_paper", label: "Illustration Glossaries (paper)", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "magnification_device", label: "Magnification Device", ospi_tier: "designated", impl_tier: "oob", strategy: "D", notes: "Software magnifier may shift to Strategy B post-entitlement." },
  { id: "medical_supports", label: "Medical Supports", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "noise_buffers", label: "Noise Buffers", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "read_aloud_human", label: "Read Aloud (human reader)", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "scribe", label: "Scribe (human)", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "separate_setting", label: "Separate Setting", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },
  { id: "simplified_test_directions", label: "Simplified Test Directions", ospi_tier: "designated", impl_tier: "oob", strategy: "D" },

  // ---- Accommodations (IEP/504) ----
  { id: "number_table_100s", label: "100s Number Table", ospi_tier: "accommodation", impl_tier: "T2", strategy: "A" },
  { id: "asl_videos", label: "American Sign Language Videos", ospi_tier: "accommodation", impl_tier: "T4", strategy: "A", notes: "Needs signed video content per item." },
  { id: "braille", label: "Braille (display or paper)", ospi_tier: "accommodation", impl_tier: "T4", strategy: "D" },
  { id: "braille_type", label: "Braille Type (UEB / Nemeth variants)", ospi_tier: "accommodation", impl_tier: "T4", strategy: "D" },
  { id: "braille_transcriptions", label: "Braille Transcriptions", ospi_tier: "accommodation", impl_tier: "T4", strategy: "D" },
  { id: "closed_captioning", label: "Closed Captioning", ospi_tier: "accommodation", impl_tier: "T3", strategy: "A" },
  { id: "emboss", label: "Emboss (tactile print)", ospi_tier: "accommodation", impl_tier: "T4", strategy: "D" },
  { id: "multiplication_table", label: "Multiplication Table", ospi_tier: "accommodation", impl_tier: "T2", strategy: "A" },
  { id: "permissive_mode", label: "Permissive Mode (allow AT apps)", ospi_tier: "accommodation", impl_tier: "T4", strategy: "B", notes: "Blocked on AAC entitlement + AT-app bundle ID inventory." },
  { id: "print_on_demand", label: "Print on Demand", ospi_tier: "accommodation", impl_tier: "T3", strategy: "A", notes: "Needs TA-side print endpoint." },
  { id: "tts_for_ela_reading", label: "TTS for ELA Reading", ospi_tier: "accommodation", impl_tier: "T2", strategy: "A", notes: "Construct-altering — flag separately per assessment." },
  { id: "tts_spanish", label: "TTS in Spanish", ospi_tier: "accommodation", impl_tier: "T2", strategy: "A" },
  { id: "speech_to_text", label: "Speech-to-Text (in-app dictation)", ospi_tier: "accommodation", impl_tier: "T3", strategy: "A" },
  { id: "word_completion", label: "Word Completion (prediction)", ospi_tier: "accommodation", impl_tier: "T2", strategy: "A" },
  { id: "calculator_non_calc_items", label: "Calculator on non-calc items", ospi_tier: "accommodation", impl_tier: "oob", strategy: "D" },
  { id: "sensory_items", label: "Sensory Items", ospi_tier: "accommodation", impl_tier: "oob", strategy: "D" },
] as const;

const ID_SET = new Set(ACCOMMODATION_CATALOG.map((e) => e.id));

export function isValidAccommodationId(id: string): boolean {
  return ID_SET.has(id);
}

export const ACCOMMODATION_IDS: readonly string[] = ACCOMMODATION_CATALOG.map(
  (e) => e.id,
);
